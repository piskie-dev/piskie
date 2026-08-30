import { createUuid } from '@shared/utils/identifiers.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConfigChangeImpact,
  ConfigPatchOperation,
  ConfigPlan,
  ConfigValidationReport,
} from '../../../shared/types/config.js';
import { configFileWriter } from './atomic-file-writer.js';

const DEFAULT_PLAN_TTL_MS = 30 * 60 * 1000;

interface StoredConfigPlan extends ConfigPlan {
  integrityHash: string;
}

export interface CreateConfigPlanInput {
  baseRevision: number;
  schemaVersion: number;
  descriptorHash: string;
  dependencyRevisions: Readonly<Record<string, number>>;
  patch: readonly ConfigPatchOperation[];
  candidate: unknown;
  affectedPaths: readonly string[];
  impacts: readonly ConfigChangeImpact[];
  validation: ConfigValidationReport;
}

export class FileConfigPlanStoreError extends Error {
  constructor(
    readonly code: 'PLAN_NOT_FOUND' | 'PLAN_EXPIRED' | 'PLAN_READ_FAILED',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FileConfigPlanStoreError';
  }
}

export class FileConfigPlanStore {
  constructor(
    private readonly domain: string,
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = DEFAULT_PLAN_TTL_MS,
  ) {}

  async create(input: CreateConfigPlanInput): Promise<ConfigPlan> {
    const createdAt = this.now();
    const draft: Omit<StoredConfigPlan, 'integrityHash'> = {
      id: createUuid(),
      domain: this.domain,
      baseRevision: input.baseRevision,
      schemaVersion: input.schemaVersion,
      descriptorHash: input.descriptorHash,
      dependencyRevisions: { ...input.dependencyRevisions },
      patch: structuredClone(input.patch),
      candidateHash: sha256Canonical(input.candidate),
      candidate: structuredClone(input.candidate),
      affectedPaths: [...new Set(input.affectedPaths)].sort(),
      impacts: structuredClone(input.impacts),
      validation: structuredClone(input.validation),
      probes: [],
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.ttlMs).toISOString(),
    };
    const plan: StoredConfigPlan = { ...draft, integrityHash: planIntegrityHash(draft) };
    await this.write(plan);
    await this.pruneExpired();
    return withoutIntegrity(plan);
  }

  async read(planId: string): Promise<ConfigPlan> {
    return withoutIntegrity(await this.readStored(planId));
  }

  async find(planId: string): Promise<ConfigPlan | undefined> {
    try {
      return await this.read(planId);
    } catch (cause) {
      if (cause instanceof FileConfigPlanStoreError && cause.code === 'PLAN_NOT_FOUND') return undefined;
      throw cause;
    }
  }

  async update(plan: ConfigPlan): Promise<ConfigPlan> {
    if (plan.domain !== this.domain || sha256Canonical(plan.candidate) !== plan.candidateHash) {
      throw new FileConfigPlanStoreError(
        'PLAN_READ_FAILED',
        `Cannot update an invalid ${this.domain} config plan: ${plan.id}`,
        { domain: this.domain, planId: plan.id },
      );
    }
    const stored: StoredConfigPlan = { ...plan, integrityHash: planIntegrityHash(plan) };
    await this.write(stored);
    return withoutIntegrity(stored);
  }

  async pruneExpired(): Promise<readonly string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.directory);
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) return [];
      throw new FileConfigPlanStoreError(
        'PLAN_READ_FAILED',
        `Unable to enumerate ${this.domain} config plans`,
        { domain: this.domain, directory: this.directory },
        { cause },
      );
    }
    const removed: string[] = [];
    await Promise.all(entries.filter((entry) => entry.endsWith('.json')).map(async (entry) => {
      const filePath = path.join(this.directory, entry);
      try {
        const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as { expiresAt?: unknown };
        if (typeof raw.expiresAt === 'string' && new Date(raw.expiresAt).getTime() <= this.now().getTime()) {
          await fs.unlink(filePath);
          removed.push(entry.slice(0, -5));
        }
      } catch {
        // Corrupt plans remain inspectable and fail explicitly when addressed by ID.
      }
    }));
    return removed.sort();
  }

  private async readStored(planId: string): Promise<StoredConfigPlan> {
    const filePath = this.planPath(planId);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) {
        throw new FileConfigPlanStoreError(
          'PLAN_NOT_FOUND',
          `Config plan not found: ${planId}`,
          { domain: this.domain, planId },
        );
      }
      throw new FileConfigPlanStoreError(
        'PLAN_READ_FAILED',
        `Unable to read config plan: ${planId}`,
        { domain: this.domain, planId },
        { cause },
      );
    }
    const plan = parsePlan(raw, this.domain, planId);
    if (new Date(plan.expiresAt).getTime() <= this.now().getTime()) {
      throw new FileConfigPlanStoreError(
        'PLAN_EXPIRED',
        `Config plan expired: ${planId}`,
        { domain: this.domain, planId, expiresAt: plan.expiresAt },
      );
    }
    if (planIntegrityHash(plan) !== plan.integrityHash) {
      throw new FileConfigPlanStoreError(
        'PLAN_READ_FAILED',
        `Config plan integrity check failed: ${planId}`,
        { domain: this.domain, planId },
      );
    }
    if (sha256Canonical(plan.candidate) !== plan.candidateHash) {
      throw new FileConfigPlanStoreError(
        'PLAN_READ_FAILED',
        `Config plan candidate hash check failed: ${planId}`,
        { domain: this.domain, planId },
      );
    }
    return plan;
  }

  private async write(plan: StoredConfigPlan): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await configFileWriter.replace(this.planPath(plan.id), `${JSON.stringify(plan, null, 2)}\n`);
  }

  private planPath(planId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(planId)) {
      throw new FileConfigPlanStoreError(
        'PLAN_NOT_FOUND',
        `Invalid config plan ID: ${planId}`,
        { domain: this.domain, planId },
      );
    }
    return path.join(this.directory, `${planId}.json`);
  }

}

export function sha256Canonical(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function planIntegrityHash(plan: Omit<StoredConfigPlan, 'integrityHash'> | StoredConfigPlan): string {
  const content: Partial<StoredConfigPlan> = { ...plan };
  delete content.integrityHash;
  return sha256Canonical(content);
}

function withoutIntegrity(plan: StoredConfigPlan): ConfigPlan {
  const publicPlan: Partial<StoredConfigPlan> = structuredClone(plan);
  delete publicPlan.integrityHash;
  return publicPlan as ConfigPlan;
}

function parsePlan(raw: unknown, domain: string, expectedId: string): StoredConfigPlan {
  if (!isRecord(raw)
    || raw.id !== expectedId
    || raw.domain !== domain
    || !Number.isInteger(raw.baseRevision)
    || !Number.isInteger(raw.schemaVersion)
    || typeof raw.descriptorHash !== 'string'
    || !isRecord(raw.dependencyRevisions)
    || !Array.isArray(raw.patch)
    || typeof raw.candidateHash !== 'string'
    || !Object.hasOwn(raw, 'candidate')
    || !Array.isArray(raw.affectedPaths)
    || !Array.isArray(raw.impacts)
    || !isRecord(raw.validation)
    || !Array.isArray(raw.probes)
    || typeof raw.createdAt !== 'string'
    || typeof raw.expiresAt !== 'string'
    || typeof raw.integrityHash !== 'string') {
    throw new FileConfigPlanStoreError(
      'PLAN_READ_FAILED',
      `Config plan has an invalid structure: ${expectedId}`,
      { domain, planId: expectedId },
    );
  }
  return raw as unknown as StoredConfigPlan;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Config plan contains a non-JSON value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
