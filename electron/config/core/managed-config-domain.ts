import { isDeepStrictEqual } from 'node:util';
import type { ZodError } from 'zod';
import type {
  ConfigApplyReceipt,
  ConfigChangeImpact,
  ConfigPatchOperation,
  ConfigPlan,
  ConfigPlanIdentity,
  ConfigValidationIssue,
  ConfigValidationReport,
  ConfigVerificationReport,
} from '../../../shared/types/config.js';
import type {
  ConfigDomainAdapter,
  ConfigDomainRegistration,
  ConfigDomainValidationContext,
  ConfigProbeInput,
} from '../contracts/domain.js';
import type { VersionedConfigDocument } from '../contracts/repository.js';
import { buildConfigDescriptor } from './descriptor-builder.js';
import { FileConfigPlanStore } from './file-plan-store.js';
import { applyJsonPatch } from './json-patch.js';
import { projectConfigWriteWide } from './schema-write-projector.js';
import { validateStrictConfigWrites } from './write-strict-validator.js';

export class ConfigKernelError extends Error {
  constructor(
    readonly code:
      | 'CONFIG_PLAN_STALE'
      | 'CONFIG_DESCRIPTOR_CHANGED'
      | 'CONFIG_VALIDATION_FAILED'
      | 'CONFIG_WRITE_PROJECTION_MISMATCH'
      | 'CONFIG_ROLLBACK_INVALID'
      | 'CONFIG_PUBLICATION_FAILED',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ConfigKernelError';
  }
}

interface CandidateEvaluation<TStored extends VersionedConfigDocument> {
  candidate?: TStored;
  validation: ConfigValidationReport;
  impacts: readonly ConfigChangeImpact[];
  dependencyRevisions: Readonly<Record<string, number>>;
}

export class ManagedConfigDomain<
  TStored extends VersionedConfigDocument,
  TRead,
  TWrite,
> implements ConfigDomainAdapter {
  readonly contract;
  private readonly plans: FileConfigPlanStore;
  private publishedRevision?: number;
  private prepared = false;
  private activationAttempted = false;
  private preparation?: Promise<void>;
  private activation?: Promise<void>;

  constructor(
    private readonly registration: ConfigDomainRegistration<TStored, TRead, TWrite>,
    plansDirectory: string,
  ) {
    this.contract = registration.contract;
    this.plans = new FileConfigPlanStore(this.contract.id, plansDirectory);
  }

  async prepare(): Promise<void> {
    if (this.prepared) return;
    if (this.preparation) return this.preparation;

    const preparation = this.prepareRepository();
    this.preparation = preparation;
    try {
      await preparation;
      this.prepared = true;
    } finally {
      if (this.preparation === preparation) this.preparation = undefined;
    }
  }

  async activate(): Promise<void> {
    await this.prepare();
    if (this.activation) return this.activation;

    const activation = this.publishCurrent();
    this.activation = activation;
    try {
      await activation;
    } finally {
      if (this.activation === activation) this.activation = undefined;
    }
  }

  private async prepareRepository(): Promise<void> {
    if (!await this.registration.repository.exists()) {
      await this.registration.repository.initialize(await this.registration.bootstrap());
    }
    await this.registration.repository.read();
    await this.registration.repository.pruneHistory();
    await this.plans.pruneExpired();
  }

  private async publishCurrent(): Promise<void> {
    const current = await this.registration.repository.read();
    if (current.revision === this.publishedRevision) return;
    const source = this.activationAttempted ? 'external' : 'bootstrap';
    this.activationAttempted = true;
    await this.registration.adapter.publish(current, {
      domain: this.contract.id,
      source,
      previousRevision: this.publishedRevision,
    });
    this.publishedRevision = current.revision;
  }

  async reloadExternal(): Promise<number | undefined> {
    await this.prepare();
    const current = await this.registration.repository.read();
    if (current.revision === this.publishedRevision) return undefined;
    if (this.publishedRevision !== undefined && current.revision < this.publishedRevision) {
      throw new ConfigKernelError(
        'CONFIG_PLAN_STALE',
        `Ignoring stale external ${this.contract.id} revision ${current.revision}`,
        { domain: this.contract.id, revision: current.revision, publishedRevision: this.publishedRevision },
      );
    }
    this.activationAttempted = true;
    await this.registration.adapter.publish(current, {
      domain: this.contract.id,
      source: 'external',
      previousRevision: this.publishedRevision,
    });
    this.publishedRevision = current.revision;
    return current.revision;
  }

  async show(): Promise<TRead> {
    const projected = await this.registration.adapter.projectRead(await this.registration.repository.read());
    return this.contract.readSchema.parse(projected) as TRead;
  }

  history(): Promise<readonly number[]> {
    return this.registration.repository.history();
  }

  async createPlan(patch: readonly ConfigPatchOperation[]): Promise<ConfigPlan> {
    const current = await this.registration.repository.read();
    const patched = applyJsonPatch(this.deriveWriteView(current), patch);
    const evaluated = await this.evaluateCandidate(current, patched, undefined, current.revision, patch);
    const descriptor = buildConfigDescriptor(this.contract);
    const plan = await this.plans.create({
      baseRevision: current.revision,
      schemaVersion: this.contract.schemaVersion,
      descriptorHash: descriptor.descriptorHash,
      dependencyRevisions: evaluated.dependencyRevisions,
      patch,
      candidate: patched,
      affectedPaths: patch.map((operation) => operation.path),
      impacts: evaluated.impacts,
      validation: evaluated.validation,
    });
    return plan;
  }

  async locatePlan(planId: string): Promise<ConfigPlanIdentity | undefined> {
    const plan = await this.plans.find(planId);
    return plan && { id: plan.id, domain: plan.domain, baseRevision: plan.baseRevision };
  }

  async validate(planId: string): Promise<ConfigPlan> {
    const plan = await this.requireCurrentPlan(planId);
    const current = await this.registration.repository.read();
    const evaluated = await this.evaluateCandidate(
      current,
      plan.candidate,
      plan.dependencyRevisions,
      plan.baseRevision,
      plan.patch,
    );
    const updated = await this.plans.update({
      ...plan,
      validation: evaluated.validation,
      impacts: evaluated.impacts,
    });
    return updated;
  }

  async probe(planId: string, input: ConfigProbeInput): Promise<unknown> {
    const probe = this.registration.adapter.probe;
    if (!probe) throw new ConfigKernelError(
      'CONFIG_VALIDATION_FAILED',
      `Config domain ${this.contract.id} does not provide a probe`,
      { domain: this.contract.id, planId },
    );
    const plan = await this.requireCurrentPlan(planId);
    const current = await this.registration.repository.read();
    const evaluated = await this.evaluateCandidate(
      current,
      plan.candidate,
      plan.dependencyRevisions,
      plan.baseRevision,
      plan.patch,
    );
    const candidate = this.requireValidCandidate(plan, evaluated);
    const receipt = await probe(candidate, input);
    await this.plans.update({
      ...plan,
      validation: evaluated.validation,
      impacts: evaluated.impacts,
      probes: [...plan.probes, receipt],
    });
    return receipt;
  }

  async apply(planId: string, expectedRevision: number): Promise<ConfigApplyReceipt> {
    const plan = await this.requireCurrentPlan(planId);
    if (plan.baseRevision !== expectedRevision) {
      throw new ConfigKernelError(
        'CONFIG_PLAN_STALE',
        `Plan ${planId} is based on revision ${plan.baseRevision}, not ${expectedRevision}`,
        { domain: this.contract.id, planId, baseRevision: plan.baseRevision, expectedRevision },
      );
    }
    const current = await this.registration.repository.read();
    if (current.revision !== expectedRevision) {
      throw new ConfigKernelError(
        'CONFIG_PLAN_STALE',
        `Current ${this.contract.id} revision is ${current.revision}, not ${expectedRevision}`,
        { domain: this.contract.id, planId, actualRevision: current.revision, expectedRevision },
      );
    }
    const evaluated = await this.evaluateCandidate(
      current,
      plan.candidate,
      plan.dependencyRevisions,
      plan.baseRevision,
      plan.patch,
    );
    const candidate = this.requireValidCandidate(plan, evaluated);
    const committed = await this.registration.repository.commit(candidate, expectedRevision);
    const publishContext = {
      domain: this.contract.id,
      source: 'apply' as const,
      previousRevision: current.revision,
    };
    try {
      this.activationAttempted = true;
      await this.registration.adapter.publish(committed, publishContext);
      this.publishedRevision = committed.revision;
    } catch (cause) {
      throw new ConfigKernelError(
        'CONFIG_PUBLICATION_FAILED',
        `${this.contract.id} revision ${committed.revision} was persisted but could not be published`,
        { domain: this.contract.id, planId, revision: committed.revision, persisted: true },
        { cause },
      );
    }
    await this.plans.update({ ...plan, validation: evaluated.validation, impacts: evaluated.impacts });
    return {
      domain: this.contract.id,
      previousRevision: current.revision,
      revision: committed.revision,
    };
  }

  async verify(expectedRevision?: number): Promise<ConfigVerificationReport> {
    const current = await this.registration.repository.read();
    if (this.registration.adapter.verify) {
      return this.registration.adapter.verify(current, expectedRevision);
    }
    const issues = expectedRevision !== undefined && current.revision !== expectedRevision
      ? [{
          code: 'CONFIG_REVISION_MISMATCH',
          message: `${this.contract.id} revision ${current.revision} does not match ${expectedRevision}`,
          expected: expectedRevision,
          actual: current.revision,
        }]
      : [];
    return {
      domain: this.contract.id,
      healthy: issues.length === 0,
      ...(expectedRevision !== undefined && { expectedRevision }),
      diskRevision: current.revision,
      issues,
    };
  }

  async rollback(targetRevision: number): Promise<ConfigApplyReceipt> {
    const current = await this.registration.repository.read();
    if (targetRevision >= current.revision) {
      throw new ConfigKernelError(
        'CONFIG_ROLLBACK_INVALID',
        `Rollback revision ${targetRevision} must be older than ${this.contract.id} revision ${current.revision}`,
        { domain: this.contract.id, targetRevision, currentRevision: current.revision },
      );
    }
    const historical = await this.registration.repository.readRevision(targetRevision);
    const historicalWrite = this.deriveWriteView(historical);
    const evaluated = await this.evaluateCandidate(
      current,
      historicalWrite,
      undefined,
      current.revision,
      [{ op: 'replace', path: '', value: historicalWrite }],
    );
    const candidate = this.requireValidCandidate(
      { id: `rollback:${targetRevision}` },
      evaluated,
    );
    const committed = await this.registration.repository.commit(candidate, current.revision);
    const publishContext = {
      domain: this.contract.id,
      source: 'rollback' as const,
      previousRevision: current.revision,
    };
    try {
      this.activationAttempted = true;
      await this.registration.adapter.publish(committed, publishContext);
      this.publishedRevision = committed.revision;
    } catch (cause) {
      throw new ConfigKernelError(
        'CONFIG_PUBLICATION_FAILED',
        `${this.contract.id} rollback was persisted as revision ${committed.revision} but could not be published`,
        {
          domain: this.contract.id,
          revision: committed.revision,
          restoredFromRevision: targetRevision,
          persisted: true,
        },
        { cause },
      );
    }
    return {
      domain: this.contract.id,
      previousRevision: current.revision,
      revision: committed.revision,
    };
  }

  private async requireCurrentPlan(planId: string): Promise<ConfigPlan> {
    const plan = await this.plans.read(planId);
    const descriptorHash = buildConfigDescriptor(this.contract).descriptorHash;
    if (plan.descriptorHash !== descriptorHash || plan.schemaVersion !== this.contract.schemaVersion) {
      throw new ConfigKernelError(
        'CONFIG_DESCRIPTOR_CHANGED',
        `Config contract changed after plan ${planId} was created`,
        {
          domain: this.contract.id,
          planId,
          planDescriptorHash: plan.descriptorHash,
          currentDescriptorHash: descriptorHash,
        },
      );
    }
    return plan;
  }

  private async evaluateCandidate(
    current: TStored,
    rawWrite: unknown,
    expectedDependencies?: Readonly<Record<string, number>>,
    expectedBaseRevision = current.revision,
    patch: readonly ConfigPatchOperation[] = [],
  ): Promise<CandidateEvaluation<TStored>> {
    const strictWriteIssues = validateStrictConfigWrites(this.contract.writeSchema, rawWrite, patch);
    if (strictWriteIssues.length > 0) {
      return {
        validation: { valid: false, issues: strictWriteIssues },
        impacts: [],
        dependencyRevisions: {},
      };
    }

    let candidate: TStored;
    try {
      candidate = await this.registration.adapter.normalizeCandidate(current, rawWrite as TWrite);
      candidate = { ...candidate, revision: current.revision };
      const normalizedWrite = this.contract.writeSchema.safeParse(this.deriveWriteView(candidate));
      const expectedWrite = this.contract.writeSchema.safeParse(rawWrite);
      if (expectedWrite.success
        && (!normalizedWrite.success || !isDeepStrictEqual(normalizedWrite.data, expectedWrite.data))) {
        throw new ConfigKernelError(
          'CONFIG_WRITE_PROJECTION_MISMATCH',
          `Config Domain ${this.contract.id} normalization changed schema-defined writable fields`,
          { domain: this.contract.id, expected: expectedWrite.data, actual: normalizedWrite },
        );
      }
    } catch (cause) {
      return {
        validation: {
          valid: false,
          issues: [{
            stage: 'semantic',
            code: errorCode(cause, 'CONFIG_NORMALIZATION_FAILED'),
            path: errorPath(cause),
            message: cause instanceof Error ? cause.message : String(cause),
          }],
        },
        impacts: [],
        dependencyRevisions: {},
      };
    }

    const projected = await this.registration.adapter.projectRead(candidate);
    const readResult = this.contract.readSchema.safeParse(projected);
    const dependencyRevisions = await this.registration.adapter.dependencyRevisions?.(candidate) ?? {};
    const context: ConfigDomainValidationContext = {
      domain: this.contract.id,
      baseRevision: expectedBaseRevision,
      dependencyRevisions,
    };
    let semantic: ConfigValidationReport;
    try {
      semantic = await this.registration.adapter.validateSemantic?.(candidate, context)
        ?? { valid: true, issues: [] };
    } catch (cause) {
      semantic = {
        valid: false,
        issues: [{
          stage: 'lifecycle',
          code: errorCode(cause, 'CONFIG_SEMANTIC_VALIDATION_FAILED'),
          path: '',
          message: cause instanceof Error ? cause.message : String(cause),
        }],
      };
    }
    const issues: ConfigValidationIssue[] = [
      ...(readResult.success ? [] : zodIssues(readResult.error)),
      ...semantic.issues,
    ];
    let valid = readResult.success
      && semantic.valid
      && semantic.issues.every((issue) => issue.severity === 'warning');
    if (current.revision !== expectedBaseRevision) {
      valid = false;
      issues.push({
        stage: 'semantic',
        code: 'CONFIG_PLAN_REVISION_CHANGED',
        path: '/revision',
        message: `Plan revision ${expectedBaseRevision} is stale; current revision is ${current.revision}`,
      });
    }
    if (expectedDependencies && !sameRevisionMap(expectedDependencies, dependencyRevisions)) {
      valid = false;
      issues.push({
        stage: 'reference',
        code: 'CONFIG_DEPENDENCY_REVISION_CHANGED',
        path: '',
        message: 'A referenced Config Domain changed after this Plan was created',
        details: { expected: expectedDependencies, actual: dependencyRevisions },
      });
    }
    const impacts = await this.registration.adapter.analyzeImpact?.(current, candidate, context) ?? [];
    return {
      candidate,
      validation: { valid, issues },
      impacts,
      dependencyRevisions,
    };
  }

  private deriveWriteView(stored: TStored): TWrite {
    return projectConfigWriteWide(this.contract.writeSchema, stored) as TWrite;
  }

  private requireValidCandidate(
    plan: Pick<ConfigPlanIdentity, 'id'>,
    evaluated: CandidateEvaluation<TStored>,
  ): TStored {
    if (!evaluated.candidate || !evaluated.validation.valid) {
      throw new ConfigKernelError(
        'CONFIG_VALIDATION_FAILED',
        `Cannot apply invalid ${this.contract.id} config plan: ${plan.id}`,
        { domain: this.contract.id, planId: plan.id, validation: evaluated.validation },
      );
    }
    return evaluated.candidate;
  }

}

function zodIssues(error: ZodError): ConfigValidationIssue[] {
  return error.issues.map((issue) => ({
    stage: 'schema',
    code: issue.code,
    path: `/${issue.path.map(escapePointerToken).join('/')}`,
    message: issue.message,
  }));
}

function escapePointerToken(value: PropertyKey): string {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function sameRevisionMap(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.every((key) => left[key] === right[key]);
}

function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return fallback;
}

function errorPath(error: unknown): string {
  return error && typeof error === 'object' && 'path' in error && typeof error.path === 'string'
    ? error.path
    : '';
}
