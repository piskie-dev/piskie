export type ConfigCapability =
  | 'show'
  | 'plan'
  | 'validate'
  | 'probe'
  | 'apply'
  | 'verify'
  | 'history'
  | 'rollback';

export type ConfigFieldMutability = 'write' | 'read-only' | 'create-only' | 'system';

export interface ConfigFieldBindingDescriptor {
  name: string;
  kind: 'record-key' | 'array-index';
}

export interface ConfigFieldDescriptor {
  fieldId: string;
  pathTemplate: string;
  bindings: ConfigFieldBindingDescriptor[];
  source: 'domain' | 'extension';
  extensionId?: string;
  leaf: boolean;
  title?: string;
  description?: string;
  jsonType?: string | string[];
  enum?: unknown[];
  default?: unknown;
  required: boolean;
  mutability: ConfigFieldMutability;
  scope?: string;
  changeImpact?: string;
  applyMode?: string;
  recommendedProbe?: string;
  billableProbe?: boolean;
}

export interface ConfigExtensionSelector {
  path: string;
  value: string;
}

export interface ConfigExtensionSchemaDescriptor {
  name: string;
  path: string;
  schema: Record<string, unknown>;
}

export interface ConfigDynamicExtensionDescriptor {
  id: string;
  kind: string;
  title: string;
  selector: ConfigExtensionSelector;
  schemas: ConfigExtensionSchemaDescriptor[];
}

export interface ConfigDescriptor {
  domain: string;
  title: string;
  description: string;
  schemaVersion: number;
  descriptorHash: string;
  capabilities: ConfigCapability[];
  readSchema: Record<string, unknown>;
  writeSchema: Record<string, unknown>;
  fields: ConfigFieldDescriptor[];
  dynamicExtensions: ConfigDynamicExtensionDescriptor[];
}

export type ConfigDomainAvailabilityState =
  | 'uninitialized'
  | 'ready'
  | 'active'
  | 'degraded'
  | 'unavailable';

export type ConfigDomainLifecycleStage = 'prepare' | 'activate' | 'publish' | 'reload';

export interface ConfigDomainAvailabilityIssue {
  stage: ConfigDomainLifecycleStage;
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface ConfigDomainAvailability {
  state: ConfigDomainAvailabilityState;
  configurable: boolean;
  runtimeActive: boolean;
  issue?: ConfigDomainAvailabilityIssue;
}

export interface ConfigDomainSummary {
  id: string;
  title: string;
  description: string;
  schemaVersion: number;
  descriptorHash: string;
  capabilities: ConfigCapability[];
  availability: ConfigDomainAvailability;
}

export type ConfigPatchOperation =
  | { op: 'add' | 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

export type ConfigFieldChange =
  | {
      op: 'set';
      fieldId: string;
      bindings?: Readonly<Record<string, string | number>>;
      value: unknown;
    }
  | {
      op: 'remove';
      fieldId: string;
      bindings?: Readonly<Record<string, string | number>>;
    };

export interface ConfigPlanRequest {
  descriptorHash: string;
  changes: readonly ConfigFieldChange[];
}

export interface ConfigPlanIdentity {
  id: string;
  domain: string;
  baseRevision: number;
}

export interface ConfigValidationIssue {
  stage: 'schema' | 'semantic' | 'reference' | 'lifecycle';
  code: string;
  path: string;
  message: string;
  severity?: 'error' | 'warning';
  details?: Readonly<Record<string, unknown>>;
}

export interface ConfigValidationReport {
  valid: boolean;
  issues: readonly ConfigValidationIssue[];
}

export interface ConfigChangeImpact {
  code: string;
  severity: 'info' | 'warning' | 'high';
  path: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface ConfigPlan extends ConfigPlanIdentity {
  schemaVersion: number;
  descriptorHash: string;
  dependencyRevisions: Readonly<Record<string, number>>;
  patch: readonly ConfigPatchOperation[];
  candidateHash: string;
  candidate: unknown;
  affectedPaths: readonly string[];
  impacts: readonly ConfigChangeImpact[];
  validation: ConfigValidationReport;
  probes: readonly unknown[];
  createdAt: string;
  expiresAt: string;
}

export interface ConfigVerificationIssue {
  code: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface ConfigVerificationReport {
  domain: string;
  healthy: boolean;
  expectedRevision?: number;
  diskRevision?: number;
  issues: readonly ConfigVerificationIssue[];
}

export interface ConfigProbeRequest {
  level: 'connectivity' | 'smoke';
  target?: Readonly<Record<string, string | undefined>>;
}

export interface ConfigApplyReceipt {
  domain: string;
  revision: number;
  previousRevision?: number;
}

export type ConfigChangeSource = 'apply' | 'rollback' | 'external';

export interface ConfigDomainRevisionChangedEvent {
  domain: string;
  revision: number;
  descriptorHash: string;
  source: ConfigChangeSource;
}
