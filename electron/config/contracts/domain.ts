import type { ZodType } from 'zod';
import type {
  ConfigApplyReceipt,
  ConfigCapability,
  ConfigChangeImpact,
  ConfigDynamicExtensionDescriptor,
  ConfigPatchOperation,
  ConfigPlanIdentity,
  ConfigProbeRequest,
  ConfigValidationReport,
  ConfigVerificationReport,
} from '../../../shared/types/config.js';
import type {
  VersionedConfigDocument,
  VersionedConfigRepository,
} from './repository.js';

export interface ConfigDomainContract {
  id: string;
  title: string;
  description: string;
  schemaVersion: number;
  readSchema: ZodType;
  writeSchema: ZodType;
  capabilities: readonly ConfigCapability[];
  extensions?: () => readonly ConfigDynamicExtensionDescriptor[];
}

export type ConfigProbeInput = ConfigProbeRequest;

export interface ConfigDomainValidationContext {
  domain: string;
  baseRevision: number;
  dependencyRevisions: Readonly<Record<string, number>>;
}

export interface ConfigDomainPublishContext {
  domain: string;
  source: 'bootstrap' | 'apply' | 'rollback' | 'external';
  previousRevision?: number;
}

export interface ConfigDomainAdapterHooks<
  TStored extends VersionedConfigDocument,
  TRead,
  TWrite,
> {
  projectRead(stored: TStored): Promise<TRead> | TRead;
  normalizeCandidate(current: TStored, patched: TWrite): Promise<TStored> | TStored;
  validateSemantic?(
    candidate: TStored,
    context: ConfigDomainValidationContext,
  ): Promise<ConfigValidationReport> | ConfigValidationReport;
  analyzeImpact?(
    current: TStored,
    candidate: TStored,
    context: ConfigDomainValidationContext,
  ): Promise<readonly ConfigChangeImpact[]> | readonly ConfigChangeImpact[];
  dependencyRevisions?(candidate: TStored): Promise<Readonly<Record<string, number>>>;
  probe?(candidate: TStored, input: ConfigProbeInput): Promise<unknown>;
  publish(
    candidate: TStored,
    context: ConfigDomainPublishContext,
  ): Promise<unknown> | unknown;
  verify?(
    candidate: TStored,
    expectedRevision?: number,
  ): Promise<ConfigVerificationReport> | ConfigVerificationReport;
}

export interface ConfigDomainRegistration<
  TStored extends VersionedConfigDocument,
  TRead,
  TWrite,
> {
  contract: ConfigDomainContract;
  repository: VersionedConfigRepository<TStored>;
  adapter: ConfigDomainAdapterHooks<TStored, TRead, TWrite>;
  bootstrap(): Promise<TStored> | TStored;
}

export interface ConfigDomainAdapter {
  readonly contract: ConfigDomainContract;
  prepare?(): Promise<void>;
  activate?(): Promise<void>;
  reloadExternal?(): Promise<number | undefined>;
  show?(): Promise<unknown>;
  history?(): Promise<readonly number[]>;
  createPlan?(patch: readonly ConfigPatchOperation[]): Promise<ConfigPlanIdentity>;
  locatePlan?(planId: string): Promise<ConfigPlanIdentity | undefined>;
  validate?(planId: string): Promise<unknown>;
  probe?(planId: string, input: ConfigProbeInput): Promise<unknown>;
  apply?(planId: string, expectedRevision: number): Promise<ConfigApplyReceipt>;
  verify?(expectedRevision?: number): Promise<unknown>;
  rollback?(targetRevision: number): Promise<ConfigApplyReceipt>;
}
