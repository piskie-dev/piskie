import type { IMGateway } from '../../im-gateway/index.js';
import { appLog } from '../../observability/logging/app-log.js';
import type { AgentService } from '../../services/agent.service.js';
import type { RuntimeComponent } from '../component-manifest.js';
import type { InferenceComponentState } from './inference.component.js';

export function createMessagingComponent(options: {
  gateway: IMGateway;
  agentService: AgentService;
  inference: InferenceComponentState;
}): RuntimeComponent<IMGateway> {
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= options.gateway.destroy();
    return closePromise;
  };

  return {
    id: 'messaging',
    requirement: 'required',
    dependsOn: ['agent'],
    async start(_context, scope) {
      scope.register({
        kind: 'custom',
        label: 'im-gateway',
        close,
        inspect: () => {
          const snapshot = options.gateway.lifecycleSnapshot();
          return !snapshot.initialized
            && snapshot.activeBotIds.length === 0
            && !snapshot.hasPowerSaveBlocker
            && snapshot.observationBindingCount === 0
            ? 'closed'
            : 'live';
        },
        describe: () => options.gateway.lifecycleSnapshot(),
      });
      await options.gateway.initialize();
      const config = options.inference.bindings?.inferenceHost.configHost;
      if (!config) throw new Error('ConfigHost is unavailable during Messaging startup');
      options.gateway.injectDependencies({
        agentService: options.agentService,
        observations: options.agentService.observations,
        config,
      });
      // ConfigHost 已发布配置，渠道和消息处理依赖也已就绪。
      // startBot 只等待启动交接，连接生命周期及重连仍由 AccountManager 管理。
      await Promise.all(options.gateway.getBotConfigs()
        .filter((bot) => bot.autoStart)
        .map(async (bot) => {
          try {
            await options.gateway.startBot(bot.id);
          } catch (error) {
            appLog.warn({
              event: 'messaging.connector.auto_start.failed',
              message: 'Messaging connector auto-start failed',
              context: { scope: 'messaging.connector', botId: bot.id, channelType: bot.channelType },
              error,
            });
          }
        }));
      return options.gateway;
    },
    stop: close,
    async verifyStopped() {
      const snapshot = options.gateway.lifecycleSnapshot();
      return {
        state: !snapshot.initialized
          && snapshot.activeBotIds.length === 0
          && !snapshot.hasPowerSaveBlocker
          && snapshot.observationBindingCount === 0
          ? 'stopped'
          : 'live',
        details: snapshot,
      };
    },
  };
}
