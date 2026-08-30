import type {
  ConfigApplyReceipt,
  ConfigDescriptor,
  ConfigDomainSummary,
  ConfigPlanIdentity,
  ConfigPlanRequest,
  ConfigProbeRequest,
} from '../../../shared/types/config.js';

export type ConfigCommandResult<T> = T | Promise<T>;

/** The narrow ConfigHost surface shared by in-process and local CLI callers. */
export interface ConfigCommandPort {
  domains(): ConfigCommandResult<ConfigDomainSummary[]>;
  describe(domain: string): ConfigCommandResult<ConfigDescriptor>;
  show<T = unknown>(domain: string): Promise<T>;
  history(domain: string): Promise<readonly number[]>;
  createPlan<T extends ConfigPlanIdentity = ConfigPlanIdentity>(
    domain: string,
    request: ConfigPlanRequest,
  ): Promise<T>;
  validate<T = unknown>(planId: string): Promise<T>;
  probe<T = unknown>(planId: string, input: ConfigProbeRequest): Promise<T>;
  apply<T extends ConfigApplyReceipt = ConfigApplyReceipt>(
    planId: string,
    expectedRevision: number,
  ): Promise<T>;
  verify<T = unknown>(domain: string, expectedRevision?: number): Promise<T>;
  rollback<T extends ConfigApplyReceipt = ConfigApplyReceipt>(
    domain: string,
    targetRevision: number,
  ): Promise<T>;
}
