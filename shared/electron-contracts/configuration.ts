import type {
  AppSettings,
  ConfigApplyReceipt,
  ConfigDescriptor,
  ConfigDomainRevisionChangedEvent,
  ConfigDomainSummary,
  ConfigPlanIdentity,
  ConfigPlanRequest,
  ConfigProbeRequest,
} from '../types/index.js';
import type { PlainInferenceAuth } from '../types/inference.js';
import type {
  ConfigChangeImpact,
  ConfigValidationReport,
} from '../types/config.js';
import type {
  ProxyProfile,
  ProxyProbeResult,
  ProxyPoolSnapshot,
} from '../types/proxy.js';

export type { ProxyProfile, ProxyPoolSnapshot } from '../types/proxy.js';

export type ProxyCreateInput = Omit<ProxyProfile, 'id'>;

export type ProxyUpdateInput = Partial<Omit<ProxyProfile, 'id'>>;

export type InferenceConnectionUpdate = Partial<{
  baseUrl: string;
  auth: PlainInferenceAuth;
  headers: Record<string, string>;
  proxyId: string | null;
}>;

export interface ConfigPlanSnapshot {
  id: string;
  domain: string;
  baseRevision: number;
  schemaVersion: number;
  descriptorHash: string;
  dependencyRevisions: Readonly<Record<string, number>>;
  candidateHash: string;
  affectedPaths: readonly string[];
  impacts: readonly ConfigChangeImpact[];
  validation: ConfigValidationReport;
  probes: readonly unknown[];
  createdAt: string;
  expiresAt: string;
}

export const CONFIGURATION_OPERATIONS = Object.freeze({
  listDomains: 'configuration.listDomains',
  describe: 'configuration.describe',
  read: 'configuration.read',
  history: 'configuration.history',
  plan: 'configuration.plan',
  validate: 'configuration.validate',
  probe: 'configuration.probe',
  apply: 'configuration.apply',
  verify: 'configuration.verify',
  rollback: 'configuration.rollback',
  readSettings: 'configuration.settings.read',
  readSetting: 'configuration.settings.readOne',
  writeSetting: 'configuration.settings.write',
  writeSettings: 'configuration.settings.writeAll',
  resetSettings: 'configuration.settings.reset',
  developmentFeatures: 'configuration.settings.developmentFeatures',
  readProxy: 'configuration.proxy.read',
  addProxy: 'configuration.proxy.add',
  updateProxy: 'configuration.proxy.update',
  removeProxy: 'configuration.proxy.remove',
  testProxy: 'configuration.proxy.test',
} as const);

export const CONFIGURATION_TOPICS = Object.freeze({
  changes: 'configuration.changes',
} as const);

export interface SettingsClient {
  read(): Promise<AppSettings>;
  readOne<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]>;
  write<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>;
  writeAll(settings: Partial<AppSettings>): Promise<void>;
  reset(): Promise<void>;
  developmentFeatures(): Promise<boolean>;
}

export interface ProxyClient {
  read(): Promise<ProxyPoolSnapshot>;
  add(proxy: ProxyCreateInput): Promise<ProxyProfile>;
  update(id: string, updates: ProxyUpdateInput): Promise<ProxyProfile>;
  remove(id: string): Promise<void>;
  test(id: string): Promise<ProxyProbeResult>;
}

export interface ConfigurationClient {
  listDomains(): Promise<ConfigDomainSummary[]>;
  describe(domain: string): Promise<ConfigDescriptor>;
  read<T = unknown>(domain: string): Promise<T>;
  history(domain: string): Promise<readonly number[]>;
  plan(domain: string, request: ConfigPlanRequest): Promise<ConfigPlanIdentity>;
  validate(planId: string): Promise<ConfigPlanSnapshot>;
  probe<T = unknown>(planId: string, request: ConfigProbeRequest): Promise<T>;
  apply(planId: string, expectedRevision: number): Promise<ConfigApplyReceipt>;
  verify<T = unknown>(domain: string, expectedRevision?: number): Promise<T>;
  rollback(domain: string, targetRevision: number): Promise<ConfigApplyReceipt>;
  observeChanges(listener: (event: ConfigDomainRevisionChangedEvent) => void): () => void;
  readonly settings: SettingsClient;
  readonly proxy: ProxyClient;
}
