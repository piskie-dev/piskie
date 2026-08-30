import type {
  AppSettings,
  BrowserEnvironment,
  TaskDefinition,
  BrowserEnvironmentGroup,
} from '../../../shared/types/index.js';
import type { MessagingConnectionConfig } from '../../../shared/types/im-gateway.js';
import type { BotState } from '../../../shared/types/im-gateway.js';
import type { ProxyPoolSnapshot } from '../../../shared/types/proxy.js';
import type { ConfigDomainPublishContext } from '../contracts/domain.js';
import { DEFAULT_SETTINGS } from '../../../shared/constants/index.js';

export interface BrowserEnvironmentsSnapshot {
  environments: BrowserEnvironment[];
  groups: BrowserEnvironmentGroup[];
}

export type ConfigDomainReader = (domain: string) => Promise<unknown>;

export interface ConfigDomainIntegrations {
  appSettings: {
    resolveInitialLanguage(): AppSettings['language'];
    publish(settings: AppSettings, context: ConfigDomainPublishContext): Promise<void> | void;
  };
  proxies: {
    publish(config: ProxyPoolSnapshot, context: ConfigDomainPublishContext): Promise<void> | void;
  };
  taskDefinitions: {
    publish(
      definitions: readonly TaskDefinition[],
      removedDefinitionIds: readonly string[],
      context: ConfigDomainPublishContext,
    ): Promise<void> | void;
  };
  browserEnvironments: {
    publish(
      snapshot: BrowserEnvironmentsSnapshot,
      context: ConfigDomainPublishContext,
    ): Promise<void> | void;
    observe?(snapshot: BrowserEnvironmentsSnapshot): BrowserEnvironmentsSnapshot;
    environmentInUse?(environmentId: string): boolean;
  };
  imBots: {
    validate(configs: readonly MessagingConnectionConfig[]): Promise<void> | void;
    publish(
      configs: readonly MessagingConnectionConfig[],
      context: ConfigDomainPublishContext,
    ): Promise<void> | void;
    observe?(configs: readonly MessagingConnectionConfig[]): readonly BotState[];
  };
  mcp: {
    publish(
      snapshot: import('../../mcp/config/domain.js').McpDomainSnapshot,
      context: ConfigDomainPublishContext,
    ): Promise<void> | void;
  };
}

export function emptyConfigDomainIntegrations(): ConfigDomainIntegrations {
  return {
    appSettings: {
      resolveInitialLanguage: () => DEFAULT_SETTINGS.language,
      publish: () => undefined,
    },
    proxies: {
      publish: () => undefined,
    },
    taskDefinitions: {
      publish: () => undefined,
    },
    browserEnvironments: {
      publish: () => undefined,
      observe: (snapshot) => snapshot,
      environmentInUse: () => false,
    },
    imBots: {
      validate: () => undefined,
      publish: () => undefined,
      observe: (configs) => configs.map((config) => ({ config, status: 'stopped' })),
    },
    mcp: {
      publish: () => undefined,
    },
  };
}
