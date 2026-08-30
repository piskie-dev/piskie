import { app } from 'electron';
import { resolveInitialAppLanguage } from '../../../shared/utils/app-language.js';
import {
  appConfigStore,
  taskDefinitionStore,
  publishProxyPoolSnapshot,
} from '../../core/storage/index.js';
import { imGateway } from '../../im-gateway/index.js';
import { browserEnvironmentRuntime } from '../../services/browser-environment-runtime.js';
import { publishGlobalMcpSnapshot } from '../../mcp/bridge/injection.js';
import { mcpConnectionManager } from '../../mcp/runtime/index.js';
import { reconcileConfiguredProxyTransports } from '../../core/proxy/proxy-resolver.js';
import type { ConfigDomainIntegrations } from '../domains/integrations.js';

export function createElectronConfigDomainIntegrations(): ConfigDomainIntegrations {
  return {
    appSettings: {
      resolveInitialLanguage: () => resolveInitialAppLanguage(
        app.getPreferredSystemLanguages()[0] ?? app.getLocale(),
      ),
      publish: (settings) => appConfigStore.publishSettings(settings),
    },
    proxies: {
      publish: (config) => {
        publishProxyPoolSnapshot(config);
        reconcileConfiguredProxyTransports(config.proxies);
        browserEnvironmentRuntime.publishProxySnapshot(config);
      },
    },
    taskDefinitions: {
      publish: async (definitions, removedDefinitionIds, context) => {
        taskDefinitionStore.publish(definitions);
        if (context.source === 'bootstrap') return;
        for (const definitionId of removedDefinitionIds) {
          await imGateway.invalidateBotsForDeletedTaskDefinition(definitionId);
        }
      },
    },
    browserEnvironments: {
      publish: (snapshot) => {
        browserEnvironmentRuntime.publishConfigSnapshot(snapshot);
      },
      observe: (snapshot) => browserEnvironmentRuntime.lifecycleSnapshot().initialized
        ? browserEnvironmentRuntime.exportConfigSnapshot()
        : snapshot,
      environmentInUse: (environmentId) => browserEnvironmentRuntime.lifecycleSnapshot().initialized
        && browserEnvironmentRuntime.getEnvironment(environmentId)?.status === 'running',
    },
    imBots: {
      validate: (configs) => imGateway.validateConfigSnapshot(configs),
      publish: (configs) => imGateway.publishConfigSnapshot(configs),
      observe: () => imGateway.getBotStates(),
    },
    mcp: {
      // 配置发布只更新未来 capability/cache；活跃 Agent 的冻结快照与独占连接不热切换。
      publish: (snapshot) => {
        publishGlobalMcpSnapshot(snapshot);
        mcpConnectionManager.invalidateCatalogCache();
      },
    },
  };
}
