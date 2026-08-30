import type { ModelTarget } from '../execution/contracts.js';
import { findCompiledTarget } from '../execution/runtime-snapshot.js';
import { CatalogQuery, resolveBoundModelDefinition } from '../catalog/query.js';
import { CanonicalCatalogSource } from '../catalog/canonical-source.js';
import {
  type CatalogSnapshot,
  type LocalCatalogDocument,
  type ModelDefinition,
} from '../catalog/contracts.js';
import type { ProbeLevel, ProbeReceipt } from '../drivers/contracts.js';
import type { DriverRegistry } from '../drivers/registry.js';
import { RuntimeSnapshotStore, type InferenceRuntimeSnapshot } from '../execution/runtime-snapshot.js';
import { ImageJobJournal } from '../image/job-journal.js';
import {
  projectInferenceRuntime,
  type InferenceRuntimeProjection,
} from './compiler.js';
import type { InferenceConfig } from './config-schema.js';
import type { InferenceConfigRepository } from './config-repository.js';
import { InferenceProbeService } from './probe-service.js';
import { readRuntimeReceipt, writeRuntimeReceipt, type RuntimeReceipt } from './runtime-receipt.js';
import type { InferenceSelections } from './selection-store.js';
import {
  parseInferenceConfig,
  type ValidationIssue,
  type ValidationReport,
} from './validation.js';
import {
  ComfyWorkflowAssetStore,
  comfyWorkflowBindingsSchema,
  type ComfyWorkflowBindings,
} from './workflow-assets.js';

export type ConfigControlErrorCode =
  | 'DRIVER_NOT_FOUND'
  | 'PLAN_VALIDATION_FAILED'
  | 'PROBE_TARGET_NOT_FOUND'
  | 'SELECTION_TARGET_NOT_FOUND';

export class ConfigControlError extends Error {
  constructor(
    readonly code: ConfigControlErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ConfigControlError';
  }
}

export interface InferenceControlPlaneOptions {
  repository: InferenceConfigRepository;
  drivers: DriverRegistry;
  runtime?: RuntimeSnapshotStore;
  journal?: ImageJobJournal;
  probes?: InferenceProbeService;
  publisher?: RuntimeReceipt['publisher'];
  now?: () => Date;
}

export interface VerificationReport {
  domain: 'inference';
  healthy: boolean;
  expectedRevision?: number;
  diskRevision?: number;
  inProcessRuntimeRevision?: number;
  receipt?: RuntimeReceipt;
  issues: readonly {
    code: string;
    message: string;
    expected?: unknown;
    actual?: unknown;
  }[];
}

export interface ModelQueryResult {
  catalogVersion: string;
  gateway: ModelDefinition['kind'];
  operation?: 'generate' | 'edit';
  models: readonly (ModelDefinition & { operationCapability?: 'supported' | 'unsupported' | 'unknown' })[];
  availableTargets: readonly (ModelTarget & { catalogId: string })[];
  issues: readonly ValidationIssue[];
}

interface EvaluatedCandidate {
  config?: InferenceConfig;
  projection?: InferenceRuntimeProjection;
  report: ValidationReport;
}

export class InferenceControlPlane {
  readonly runtime: RuntimeSnapshotStore;
  readonly workflows: ComfyWorkflowAssetStore;
  readonly probes: InferenceProbeService;
  private readonly catalogSource: CanonicalCatalogSource;
  private readonly now: () => Date;
  private readonly publisher: RuntimeReceipt['publisher'];

  constructor(private readonly options: InferenceControlPlaneOptions) {
    this.runtime = options.runtime ?? new RuntimeSnapshotStore();
    this.workflows = new ComfyWorkflowAssetStore(options.repository.paths.workflowDirectory);
    this.now = options.now ?? (() => new Date());
    this.publisher = options.publisher ?? 'electron';
    this.catalogSource = new CanonicalCatalogSource({
      rootDirectory: options.repository.paths.rootDirectory,
      now: this.now,
    });
    this.probes = options.probes ?? new InferenceProbeService({
      drivers: options.drivers,
      journal: options.journal ?? new ImageJobJournal(options.repository.paths.imageJobDirectory, this.now),
      now: this.now,
    });
  }

  get configRepository(): InferenceConfigRepository {
    return this.options.repository;
  }

  importComfyWorkflow(source: string | unknown) {
    return this.workflows.import(source);
  }

  inspectComfyWorkflow(assetId: string) {
    return this.workflows.inspect(assetId);
  }

  detectComfyWorkflowBindings(assetId: string) {
    return this.workflows.detectBindings(assetId);
  }

  validateComfyWorkflowBindings(
    assetId: string,
    rawBindings: unknown,
    outputNodeIds: readonly string[],
  ) {
    const bindings: ComfyWorkflowBindings = comfyWorkflowBindingsSchema.parse(rawBindings);
    return this.workflows.validateBindings(assetId, bindings, outputNodeIds);
  }

  drivers(): readonly {
    id: string;
    supportedGateways: readonly ('ai' | 'image')[];
    acceptedAuth: readonly string[];
  }[] {
    return this.options.drivers.list().map((driver) => ({
      id: driver.manifest.id,
      supportedGateways: driver.manifest.supportedGateways,
      acceptedAuth: driver.manifest.acceptedAuth,
    }));
  }

  driverSchema(driverId: string): Record<string, unknown> {
    const driver = this.options.drivers.get(driverId);
    if (!driver) {
      throw new ConfigControlError(
        'DRIVER_NOT_FOUND',
        `Inference driver is not registered: ${driverId}`,
        { driverId },
      );
    }
    return {
      id: driver.manifest.id,
      supportedGateways: driver.manifest.supportedGateways,
      acceptedAuth: driver.manifest.acceptedAuth,
      providerOptions: driver.manifest.providerConfigSchema,
      modelOptions: driver.manifest.modelOptionsSchema,
    };
  }

  async models(
    gateway: ModelDefinition['kind'],
    operation?: 'generate' | 'edit',
    signal?: AbortSignal,
  ): Promise<ModelQueryResult> {
    const config = await this.options.repository.read();
    const catalog = await this.loadCatalogSnapshot(signal);
    const projection = projectInferenceRuntime(config, catalog, this.options.drivers, this.now);
    const query = new CatalogQuery(resolveConfiguredBindings(config, catalog));
    return {
      catalogVersion: catalog.version,
      gateway,
      ...(operation && { operation }),
      models: query.list(gateway).map((model) => ({
        ...model,
        ...(operation && { operationCapability: query.capability(model.id, operation) }),
      })),
      availableTargets: availableTargets(projection.snapshot, gateway),
      issues: projection.issues,
    };
  }

  async assertSelectableTarget(target: ModelTarget, gateway: 'ai' | 'image'): Promise<void> {
    const config = await this.options.repository.read();
    const catalog = await this.loadCatalogSnapshot();
    const snapshot = projectInferenceRuntime(config, catalog, this.options.drivers, this.now).snapshot;
    const compiled = findCompiledTarget(snapshot, target);
    const available = gateway === 'ai' ? compiled?.ai : compiled?.image;
    if (!available) {
      throw new ConfigControlError(
        'SELECTION_TARGET_NOT_FOUND',
        `Configured ${gateway} target was not found: ${target.providerId}/${target.modelId}`,
        { gateway, target },
      );
    }
  }

  async filterSelections(candidate: InferenceSelections): Promise<InferenceSelections> {
    const config = await this.options.repository.read();
    const catalog = await this.loadCatalogSnapshot();
    const snapshot = projectInferenceRuntime(config, catalog, this.options.drivers, this.now).snapshot;
    const filtered = { ...candidate };
    if (filtered.ai && !findCompiledTarget(snapshot, filtered.ai)?.ai) delete filtered.ai;
    if (filtered.image && !findCompiledTarget(snapshot, filtered.image)?.image) delete filtered.image;
    return filtered;
  }

  async validateCatalogCandidate(candidate: LocalCatalogDocument): Promise<ValidationReport> {
    const config = await this.options.repository.read();
    const catalog = await this.catalogSource.loadCandidate(candidate);
    const projection = projectInferenceRuntime(config, catalog, this.options.drivers, this.now);
    return { valid: true, issues: projection.issues };
  }

  async publishCatalogCandidate(candidate: LocalCatalogDocument): Promise<void> {
    const config = await this.options.repository.read();
    const catalog = await this.catalogSource.loadCandidate(candidate);
    const snapshot = projectInferenceRuntime(config, catalog, this.options.drivers, this.now).snapshot;
    this.runtime.publish(snapshot);
    await this.publishReceipt(snapshot);
  }

  async validateConfigCandidate(
    candidate: InferenceConfig,
    signal?: AbortSignal,
  ): Promise<ValidationReport> {
    return (await this.evaluateCandidate(candidate, signal)).report;
  }

  async probeConfigCandidate(
    candidate: InferenceConfig,
    level: ProbeLevel,
    target?: Partial<ModelTarget>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<readonly ProbeReceipt[]> {
    const evaluated = await this.evaluateCandidate(candidate, signal);
    if (!evaluated.config || !evaluated.projection || !evaluated.report.valid) {
      throw new ConfigControlError(
        'PLAN_VALIDATION_FAILED',
        'Cannot probe an invalid inference config candidate',
        { report: evaluated.report },
      );
    }
    const receipts = await this.probes.run(
      evaluated.config,
      evaluated.projection.snapshot,
      level,
      target,
      signal,
    );
    this.assertProbeMatched(receipts, level, target);
    return receipts;
  }

  async publishConfigCandidate(candidate: InferenceConfig): Promise<void> {
    const evaluated = await this.evaluateCandidate(candidate);
    if (!evaluated.projection || !evaluated.report.valid) {
      throw new ConfigControlError(
        'PLAN_VALIDATION_FAILED',
        'Cannot publish an invalid inference config candidate',
        { report: evaluated.report },
      );
    }
    const snapshot = evaluated.projection.snapshot;
    this.runtime.publish(snapshot);
    await this.publishReceipt(snapshot);
  }

  async probeCurrent(
    level: ProbeLevel,
    target?: Partial<ModelTarget>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<readonly ProbeReceipt[]> {
    const config = await this.options.repository.read();
    const catalog = await this.loadCatalogSnapshot(signal);
    const snapshot = projectInferenceRuntime(config, catalog, this.options.drivers, this.now).snapshot;
    const receipts = await this.probes.run(config, snapshot, level, target, signal);
    this.assertProbeMatched(receipts, level, target);
    return receipts;
  }

  async loadCurrent(signal?: AbortSignal): Promise<InferenceRuntimeSnapshot> {
    const config = await this.options.repository.read();
    const catalog = await this.loadCatalogSnapshot(signal);
    const snapshot = projectInferenceRuntime(config, catalog, this.options.drivers, this.now).snapshot;
    this.runtime.publish(snapshot);
    await this.publishReceipt(snapshot);
    return snapshot;
  }

  async verify(expectedRevision?: number): Promise<VerificationReport> {
    const issues: VerificationReport['issues'][number][] = [];
    let diskRevision: number | undefined;
    try {
      diskRevision = (await this.options.repository.read()).revision;
    } catch (cause) {
      issues.push({ code: 'DISK_CONFIG_UNREADABLE', message: cause instanceof Error ? cause.message : String(cause) });
    }
    const inProcessRuntimeRevision = this.runtime.capture()?.configRevision;
    let receipt: RuntimeReceipt | undefined;
    try {
      receipt = await readRuntimeReceipt(this.options.repository.paths);
    } catch (cause) {
      issues.push({ code: 'RUNTIME_RECEIPT_INVALID', message: cause instanceof Error ? cause.message : String(cause) });
    }
    const wanted = expectedRevision ?? diskRevision;
    if (wanted !== undefined && diskRevision !== wanted) {
      issues.push({
        code: 'DISK_REVISION_MISMATCH',
        message: `Disk revision ${String(diskRevision)} does not match ${wanted}`,
        expected: wanted,
        actual: diskRevision,
      });
    }
    const durableRuntimeRevision = receipt?.publisher === 'electron' ? receipt.revision : undefined;
    const effectiveRuntimeRevision = inProcessRuntimeRevision ?? durableRuntimeRevision;
    if (wanted !== undefined && effectiveRuntimeRevision !== wanted) {
      issues.push({
        code: 'RUNTIME_REVISION_MISMATCH',
        message: `Runtime revision ${String(effectiveRuntimeRevision)} does not match ${wanted}`,
        expected: wanted,
        actual: effectiveRuntimeRevision,
      });
    }
    return {
      domain: 'inference',
      healthy: issues.length === 0,
      ...(expectedRevision !== undefined && { expectedRevision }),
      ...(diskRevision !== undefined && { diskRevision }),
      ...(inProcessRuntimeRevision !== undefined && { inProcessRuntimeRevision }),
      ...(receipt && { receipt }),
      issues,
    };
  }

  private async evaluateCandidate(
    rawCandidate: unknown,
    signal?: AbortSignal,
  ): Promise<EvaluatedCandidate> {
    const parsed = parseInferenceConfig(rawCandidate);
    if (!parsed.config) return { report: parsed.report };
    const issues: ValidationIssue[] = [...parsed.report.issues];

    let catalog: CatalogSnapshot;
    try {
      catalog = await this.loadCatalogSnapshot(signal);
    } catch (cause) {
      issues.push({
        stage: 'semantic',
        code: errorCode(cause, 'CATALOG_LOAD_FAILED'),
        path: '/providers',
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return { config: parsed.config, report: { valid: false, issues } };
    }
    const projection = projectInferenceRuntime(parsed.config, catalog, this.options.drivers, this.now);
    issues.push(...projection.issues);
    return {
      config: parsed.config,
      projection,
      report: {
        valid: issues.every((issue) => issue.severity === 'warning'),
        issues,
      },
    };
  }

  loadCatalogSnapshot(signal?: AbortSignal): Promise<CatalogSnapshot> {
    return this.catalogSource.load(signal);
  }

  private async publishReceipt(snapshot: InferenceRuntimeSnapshot): Promise<RuntimeReceipt> {
    const receipt: RuntimeReceipt = {
      schemaVersion: 1,
      domain: 'inference',
      revision: snapshot.configRevision,
      catalogVersion: snapshot.catalogVersion,
      publisher: this.publisher,
      processId: process.pid,
      publishedAt: this.now().toISOString(),
    };
    await writeRuntimeReceipt(this.options.repository.paths, receipt);
    return receipt;
  }

  private assertProbeMatched(
    receipts: readonly ProbeReceipt[],
    level: ProbeLevel,
    target: Partial<ModelTarget> | undefined,
  ): void {
    if (receipts.length > 0) return;
    throw new ConfigControlError(
      'PROBE_TARGET_NOT_FOUND',
      'No enabled Provider or model matched the requested probe target',
      { target, level },
    );
  }

}

function resolveConfiguredBindings(
  config: InferenceConfig,
  catalog: CatalogSnapshot,
): CatalogSnapshot {
  const models = new Map(catalog.models);
  for (const provider of Object.values(config.providers)) {
    for (const binding of Object.values(provider.models)) {
      const resolved = resolveBoundModelDefinition(catalog, {
        catalogId: binding.catalogId,
        upstreamId: binding.upstreamId,
        driverId: provider.driver,
      });
      if (resolved) models.set(binding.catalogId, resolved);
    }
  }
  return { ...catalog, models };
}

function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return fallback;
}

function availableTargets(
  snapshot: InferenceRuntimeSnapshot,
  gateway: ModelDefinition['kind'],
): Array<ModelTarget & { catalogId: string }> {
  const targets: Array<ModelTarget & { catalogId: string }> = [];
  for (const [providerId, models] of snapshot.targets) {
    for (const [modelId, target] of models) {
      if (gateway === 'ai' ? !target.ai : !target.image) continue;
      targets.push({ providerId, modelId, catalogId: target.catalogId });
    }
  }
  return targets.sort((left, right) => left.providerId.localeCompare(right.providerId)
    || left.modelId.localeCompare(right.modelId));
}
