import type {
  ConfigDescriptor,
  ConfigDomainSummary,
} from '../../../shared/types/config.js';
import type { ConfigDomainAdapter } from '../contracts/domain.js';
import { buildConfigDescriptor } from './descriptor-builder.js';

const CAPABILITY_METHODS = {
  show: 'show',
  plan: 'createPlan',
  validate: 'validate',
  probe: 'probe',
  apply: 'apply',
  verify: 'verify',
  history: 'history',
  rollback: 'rollback',
} as const;

type RegisteredConfigDomainSummary = Omit<ConfigDomainSummary, 'availability'>;

export class ConfigDomainRegistryError extends Error {
  constructor(
    readonly code:
      | 'CONFIG_DOMAIN_DUPLICATE'
      | 'CONFIG_DOMAIN_NOT_FOUND'
      | 'CONFIG_DOMAIN_CONTRACT_INVALID',
    message: string,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ConfigDomainRegistryError';
  }
}

export class ConfigDomainRegistry {
  private readonly domains = new Map<string, ConfigDomainAdapter>();

  register(domain: ConfigDomainAdapter): void {
    const id = domain.contract.id;
    if (this.domains.has(id)) {
      throw new ConfigDomainRegistryError(
        'CONFIG_DOMAIN_DUPLICATE',
        `Config domain is already registered: ${id}`,
        { domain: id },
      );
    }
    this.assertAdapterCapabilities(domain);
    this.domains.set(id, domain);
  }

  get(domainId: string): ConfigDomainAdapter {
    const domain = this.domains.get(domainId);
    if (!domain) {
      throw new ConfigDomainRegistryError(
        'CONFIG_DOMAIN_NOT_FOUND',
        `Config domain is not registered: ${domainId}`,
        { domain: domainId },
      );
    }
    return domain;
  }

  describe(domainId: string): ConfigDescriptor {
    return buildConfigDescriptor(this.get(domainId).contract);
  }

  list(): RegisteredConfigDomainSummary[] {
    return [...this.domains.values()]
      .map((domain) => {
        const descriptor = buildConfigDescriptor(domain.contract);
        return {
          id: descriptor.domain,
          title: descriptor.title,
          description: descriptor.description,
          schemaVersion: descriptor.schemaVersion,
          descriptorHash: descriptor.descriptorHash,
          capabilities: descriptor.capabilities,
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private assertAdapterCapabilities(domain: ConfigDomainAdapter): void {
    const capabilities = new Set(domain.contract.capabilities);
    if (capabilities.size !== domain.contract.capabilities.length) {
      throw new ConfigDomainRegistryError(
        'CONFIG_DOMAIN_CONTRACT_INVALID',
        `Config domain declares duplicate capabilities: ${domain.contract.id}`,
        { domain: domain.contract.id },
      );
    }
    for (const capability of capabilities) {
      const method = CAPABILITY_METHODS[capability];
      if (typeof domain[method] !== 'function') {
        throw new ConfigDomainRegistryError(
          'CONFIG_DOMAIN_CONTRACT_INVALID',
          `Config domain ${domain.contract.id} declares ${capability} without implementing ${method}()`,
          { domain: domain.contract.id, capability, method },
        );
      }
    }
    if ([...capabilities].some((capability) => (
      capability === 'validate' || capability === 'probe' || capability === 'apply'
    )) && typeof domain.locatePlan !== 'function') {
      throw new ConfigDomainRegistryError(
        'CONFIG_DOMAIN_CONTRACT_INVALID',
        `Config domain ${domain.contract.id} must implement locatePlan() for persisted Plan routing`,
        { domain: domain.contract.id, method: 'locatePlan' },
      );
    }
  }
}
