import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * IMGateway — IM Gateway 系统的门面类
 *
 * 单一入口，消费 ConfigHost 发布的 Bot 配置，并管理账号会话、授权用户和待授权请求。
 */

import { app, powerSaveBlocker } from 'electron';
import path from 'path';
import {
  createChangeChannel,
  type ChangeSource,
  type Unsubscribe,
} from '../core/change-channel.js';
import { taskDefinitionStore } from '../core/storage/index.js';
import { AccountManager } from './account-manager.js';
import { ReplyInterceptor } from './reply-interceptor.js';
import { InboundPipeline } from './core/inbound-pipeline.js';
import { IMCommandRouter } from './commands/command-router.js';
import { ClearCommandHandler } from './commands/clear.command.js';
import { channelRegistry } from './core/registry.js';
import { registerBuiltinChannels, BUILTIN_CHANNEL_INFOS } from './channels/index.js';
import { AccountSessionStore } from './account-session-store.js';
import { ConfigAgentBindings } from './config-agent-bindings.js';
import { MessagingAgentSession } from './messaging-agent-session.js';
import { SenderAuthorizationRegistry } from './sender-authorization-registry.js';
import type { ConfigHost } from '../config/host/config-host.js';
import type { IMAgentCommands, IMAgentObservations } from './agent-ports.js';
import type {
  AuthorizedUser,
  MessagingConnectionConfig,
  BotState,
  BotStatus,
  SenderAuthorizationRequest,
  MessagingConnectorDescriptor,
  QrLoginStartResult,
  QrLoginWaitResult,
  QrLoginSubmitCodeResult,
  QrLoginCancelResult,
  LogoutResult,
  MessagingRuntimeChangedEvent,
} from '../../shared/types/im-gateway.js';

// ---------------------------------------------------------------------------
// IMGateway
// ---------------------------------------------------------------------------

export class IMGateway {
  private accountSessions: AccountSessionStore;
  private senderAuthorizationRegistry: SenderAuthorizationRegistry;
  private agentBindings?: ConfigAgentBindings;

  // Sub-components
  private accountManager: AccountManager;
  private replyInterceptor: ReplyInterceptor;
  /** 内置渠道进站管线 */
  private inboundPipeline: InboundPipeline;

  // In-memory state
  private botConfigs: MessagingConnectionConfig[] = [];
  private initialized = false;
  // Power save blocker — prevent system sleep while any bot is running
  private powerSaveBlockerId: number | null = null;

  private readonly statusChangeChannel = createChangeChannel<MessagingRuntimeChangedEvent>({
    onSubscriberError: (error) =>
      appLog.error({
        event: 'messaging.status.publish.failed',
        message: 'Messaging status publication failed',
        context: { scope: 'messaging.status' },
        error: error,
      }),
  });
  readonly statusChanges: ChangeSource<MessagingRuntimeChangedEvent> =
    this.statusChangeChannel.source;
  readonly authorizationRequests: ChangeSource<SenderAuthorizationRequest>;

  /** Agent output 转发前的顶层主 Agent 存在性守卫与 IM command port。 */
  private agentService?: IMAgentCommands;
  private agentObservationBindings: Unsubscribe[] = [];

  constructor() {
    this.senderAuthorizationRegistry = new SenderAuthorizationRegistry(
      path.join(app.getPath('userData'), 'im-gateway')
    );
    this.authorizationRequests = this.senderAuthorizationRegistry.changes;
    this.accountSessions = new AccountSessionStore(
      path.join(app.getPath('userData'), 'runtime-state', 'im-account-sessions.json')
    );
    // Initialize sub-components
    this.replyInterceptor = new ReplyInterceptor();

    this.inboundPipeline = new InboundPipeline({
      replyInterceptor: this.replyInterceptor,
      authorization: this.senderAuthorizationRegistry,
    });

    this.accountManager = new AccountManager({
      onStatusChange: (botId, state) => {
        // stop_failed 后迟到 settle 可能留下悬空绑定，推送状态时按当前执行派生。
        // 自动发布的 stopped 不得把配置错误实时显示回「已停止」——与 getBotStates
        // 读取期派生同源；仅覆盖 stopped 终态，不动 starting/stopping 等生命周期
        if (state.status === 'stopped' && this.isTaskDefinitionUnavailable(state.config)) {
          state = {
            config: state.config,
            status: 'error',
            error: this.describeUnavailableTaskDefinition(state.config),
          };
        }
        this.statusChangeChannel.sink.publish({ botId, state });
        this.updatePowerSaveBlocker();
      },
    });
  }

  // ==================================================================
  // Lifecycle
  // ==================================================================

  /**
   * Inject PISKIE service dependencies (called after services are initialized).
   * This allows the gateway to interact with the agent system.
   */
  injectDependencies(deps: {
    agentService: IMAgentCommands;
    observations: IMAgentObservations;
    config: ConfigHost;
  }): void {
    this.detachAgentObservations();
    this.agentService = deps.agentService;
    this.agentBindings = new ConfigAgentBindings(deps.config);
    // 命令注册表在此装配：InboundPipeline 不导入具体 command class
    this.inboundPipeline.setDependencies({
      agentService: deps.agentService,
      agentSessions: new MessagingAgentSession(deps.agentService, this.agentBindings),
      commandRouter: new IMCommandRouter([new ClearCommandHandler()]),
    });

    this.agentObservationBindings.push(
      deps.observations.outputs.subscribe((event) => {
        // 顶层主 Agent 必须存在才转发——子 Agent 内容不直接发往 IM
        if (!this.agentService?.hasAgentInMemory(event.agentId)) return;
        this.replyInterceptor.processStateEvent(event.agentId, event);
      }),
      deps.observations.runtimeReleases.subscribe((event) => {
        // 本地清理异常不外溢：不阻断其他 observer，也不回调 AgentService。
        try {
          this.replyInterceptor.removeBinding(event.agentId);
        } catch (error) {
          appLog.warn({
            event: 'messaging.reply_binding.release.degraded',
            message: 'Messaging reply binding release degraded',
            context: { scope: 'messaging.reply_binding', agentId: event.agentId },
            error,
          });
        }
      })
    );
  }

  private detachAgentObservations(): void {
    for (const unsubscribe of this.agentObservationBindings.splice(0)) {
      try {
        unsubscribe();
      } catch (error) {
        appLog.warn({
          event: 'messaging.observation.detach.degraded',
          message: 'Messaging observation detach degraded',
          context: { scope: 'messaging.observation' },
          error,
        });
      }
    }
  }

  /** Initialize the gateway — load persisted data and prepare plugins dir */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.accountSessions.load();
    this.botConfigs = this.botConfigs.map((config) => {
      const pluginAccountId = this.accountSessions.get(config.id);
      return { ...config, ...(pluginAccountId && { pluginAccountId }) };
    });

    this.senderAuthorizationRegistry.load();

    // Register built-in channels
    registerBuiltinChannels();
    this.initialized = true;

    appLog.info({
      event: 'messaging.gateway.initialize.completed',
      message: 'Messaging gateway initialized',
      context: {
        scope: 'messaging.gateway',
        authorizedUserCount: this.senderAuthorizationRegistry.authorizedUserCount(),
      },
    });
  }

  /** Destroy the gateway — stop all bots and clean up */
  async destroy(): Promise<void> {
    this.detachAgentObservations();
    const failures: unknown[] = [];
    try {
      await this.accountManager.destroy();
    } catch (error) {
      failures.push(error);
    }

    // Release power save blocker
    if (this.powerSaveBlockerId !== null) {
      try {
        powerSaveBlocker.stop(this.powerSaveBlockerId);
      } catch (error) {
        failures.push(error);
      }
      this.powerSaveBlockerId = null;
    }

    this.senderAuthorizationRegistry.clearRuntimeRequests();
    this.initialized = false;

    if (failures.length > 0) {
      throw new AggregateError(failures, 'IMGateway failed to destroy every account resource');
    }
    appLog.info({
      event: 'messaging.gateway.stop.completed',
      message: 'Messaging gateway stopped',
      context: { scope: 'messaging.gateway' },
    });
  }

  lifecycleSnapshot(): {
    initialized: boolean;
    activeBotIds: readonly string[];
    hasPowerSaveBlocker: boolean;
    observationBindingCount: number;
  } {
    const activeBotIds = [...this.accountManager.getAllBotStates().entries()]
      .filter(([, state]) => state.status === 'running' || state.status === 'starting')
      .map(([botId]) => botId);
    return Object.freeze({
      initialized: this.initialized,
      activeBotIds: Object.freeze(activeBotIds),
      hasPowerSaveBlocker: this.powerSaveBlockerId !== null,
      observationBindingCount: this.agentObservationBindings.length,
    });
  }

  /**
   * 根据当前 bot 运行状态，启用或释放系统休眠阻止。
   * 有任意 bot 处于 running/starting 状态时阻止休眠，全部停止后恢复。
   */
  private updatePowerSaveBlocker(): void {
    const allStates = this.accountManager.getAllBotStates();
    const hasActiveBots = [...allStates.values()].some(
      (s) => s.status === 'running' || s.status === 'starting'
    );

    if (hasActiveBots && this.powerSaveBlockerId === null) {
      this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!hasActiveBots && this.powerSaveBlockerId !== null) {
      powerSaveBlocker.stop(this.powerSaveBlockerId);

      this.powerSaveBlockerId = null;
    }
  }

  /** List the connector types available to messaging connections. */
  async listConnectors(): Promise<MessagingConnectorDescriptor[]> {
    return BUILTIN_CHANNEL_INFOS.filter((p) => channelRegistry.has(p.channelId));
  }

  // ==================================================================
  // ConfigHost Bot snapshot
  // ==================================================================

  private assertTaskDefinitionAvailable(config: MessagingConnectionConfig): void {
    if (this.isTaskDefinitionUnavailable(config)) {
      throw new Error(this.describeUnavailableTaskDefinition(config));
    }
  }

  private isTaskDefinitionUnavailable(config: MessagingConnectionConfig): boolean {
    if (!config.definitionId) return true;
    const definition = taskDefinitionStore.get(config.definitionId);
    return !definition || definition.purpose !== 'messaging';
  }

  /** Get all bot configs */
  getBotConfigs(): MessagingConnectionConfig[] {
    return structuredClone(this.botConfigs);
  }

  validateConfigSnapshot(configs: readonly MessagingConnectionConfig[]): void {
    const ids = new Set<string>();
    for (const config of configs) {
      if (ids.has(config.id)) throw new Error(`Duplicate Bot config ID: ${config.id}`);
      ids.add(config.id);
      if (config.definitionId && this.isTaskDefinitionUnavailable(config)) {
        throw new Error(this.describeUnavailableTaskDefinition(config));
      }
      const existing = this.botConfigs.find((bot) => bot.id === config.id);
      if (
        existing &&
        existing.definitionId !== config.definitionId &&
        !this.accountManager.isConnectorQuiescent(config.id)
      ) {
        throw new Error('task_definition_binding_locked: 请先停止 Bot，再修改启动任务绑定');
      }
    }
  }

  /** ConfigHost publication bridge; running connectors retain their startup snapshots. */
  async publishConfigSnapshot(configs: readonly MessagingConnectionConfig[]): Promise<void> {
    const nextIds = new Set(configs.map((config) => config.id));
    for (const current of this.botConfigs) {
      if (!nextIds.has(current.id) && !this.accountManager.isConnectorQuiescent(current.id)) {
        await this.stopBot(current.id);
      }
    }
    this.accountSessions.retain(nextIds);
    this.botConfigs = structuredClone(
      configs.map((config) => {
        const pluginAccountId = this.accountSessions.get(config.id);
        return { ...config, ...(pluginAccountId && { pluginAccountId }) };
      })
    );
  }

  // ==================================================================
  // Bot lifecycle
  // ==================================================================

  /** Start a bot — 同步安装 reservation 后连接（执行存在时拒绝） */
  async startBot(botId: string): Promise<void> {
    const config = this.botConfigs.find((b) => b.id === botId);
    if (!config) throw new Error(`Bot config not found: ${botId}`);
    this.assertTaskDefinitionAvailable(config);
    const reservation = this.accountManager.reserveStarting(config);
    try {
      await this.startBotWithReservation(reservation);
    } catch (error: any) {
      this.accountManager.failExecution(reservation, error?.message || String(error));
      throw error;
    }
  }

  private async startBotWithReservation(
    reservation: import('./account-manager.js').AccountExecution
  ): Promise<void> {
    // 使用 reservation 快照配置：save 先赢则本次启动读到的已是改绑后的完整配置。
    // Connector 创建放进 startFn 闭包：AccountManager 先做预留
    // CAS/stopRequested 检查，stop 抢先的 deferred start 不创建任何 Connector 对象
    const config = reservation.config;
    await this.accountManager.startConnector(
      config,
      (signal) => {
        const connector = channelRegistry.create(config);
        if (!connector) {
          throw new Error(`No built-in connector for channel type: ${config.channelType}`);
        }
        return connector.start(this.inboundPipeline.buildContext(config, signal));
      },
      { reservation }
    );
    appLog.info({
      event: 'messaging.connector.start.completed',
      message: 'Messaging connector started',
      context: {
        scope: 'messaging.connector',
        botId: config.id,
        channelType: config.channelType,
      },
    });
  }

  /** Stop a bot — 停止完成 barrier（settle 才发布 stopped；timeout 抛 connector_stop_timeout） */
  async stopBot(botId: string): Promise<void> {
    // 幂等 owner binding 清理：stop 请求与 settle 各一次，
    // 期间排队回调无法永久复活已删除的 binding（新消息 setDispatcher 属正常重建）
    this.replyInterceptor.removeBindingsByOwner(botId);
    try {
      await this.accountManager.stopBot(botId);
    } finally {
      this.replyInterceptor.removeBindingsByOwner(botId);
    }
    appLog.info({
      event: 'messaging.connector.stop.completed',
      message: 'Messaging connector stopped',
      context: { scope: 'messaging.connector', botId: botId },
    });
  }

  async invalidateBotsForDeletedTaskDefinition(
    definitionId: string
  ): Promise<Array<{ botId: string; name: string; stopError?: string }>> {
    const affected = this.botConfigs.filter((bot) => bot.definitionId === definitionId);
    const results: Array<{ botId: string; name: string; stopError?: string }> = [];
    const stopFailures: unknown[] = [];
    for (const bot of affected) {
      let stopError: string | undefined;
      if (!this.accountManager.isConnectorQuiescent(bot.id)) {
        try {
          await this.stopBot(bot.id);
        } catch (e: any) {
          stopError = e?.message || String(e);
          stopFailures.push(e);
        }
      }
      this.accountManager.publishConfigError(bot, this.describeUnavailableTaskDefinition(bot));
      results.push({ botId: bot.id, name: bot.name, stopError });
    }
    if (stopFailures.length > 0) {
      appLog.warn({
        event: 'messaging.task_definition_binding.invalidate.degraded',
        message: 'Messaging Task Definition binding invalidation degraded',
        context: {
          scope: 'messaging.task_definition_binding',
          definitionId,
          failedBotIds: results.filter((item) => item.stopError).map((item) => item.botId),
        },
        error: new AggregateError(stopFailures, 'Failed to stop every affected connector'),
      });
    }
    return results;
  }

  private describeUnavailableTaskDefinition(config: MessagingConnectionConfig): string {
    const definition = config.definitionId
      ? taskDefinitionStore.get(config.definitionId)
      : null;
    if (definition && definition.purpose !== 'messaging') {
      return `task_definition_purpose_mismatch: Bot「${config.name}」只能绑定 messaging 用途的任务模板（${definition.definitionId}）`;
    }
    return `task_definition_unavailable: Bot「${config.name}」未绑定可用的启动任务（${config.definitionId || '未绑定'}），请在设置中重新绑定`;
  }

  async removeAgentBindings(agentId: string): Promise<void> {
    if (!this.agentBindings) throw new Error('Messaging Agent bindings are unavailable');
    await this.agentBindings.removeAgent(agentId);
  }

  // ==================================================================
  // QR login / logout (for channels like openclaw-weixin)
  // ==================================================================

  /** 为 QR/登出等无需运行中 bot 的账号操作构建内置 connector（bot 配置可能尚未保存） */
  private createBuiltinConnectorFor(botId: string, channelType: string) {
    const config =
      this.botConfigs.find((b) => b.id === botId) ??
      ({
        id: botId,
        channelType,
        name: botId,
        appId: '',
        appSecret: '',
      } as MessagingConnectionConfig);
    return channelRegistry.create(config);
  }

  /** Start QR login — returns QR data URL for display */
  async loginWithQrStart(
    botId: string,
    channelType: string,
    force?: boolean
  ): Promise<QrLoginStartResult> {
    const connector = this.createBuiltinConnectorFor(botId, channelType);
    if (!connector?.loginWithQrStart) {
      throw new Error('Channel does not support QR login (loginWithQrStart not implemented)');
    }
    const result = await connector.loginWithQrStart({ accountId: botId, force: force ?? false });
    appLog.info({
      event: 'messaging.qr_login.start.completed',
      message: 'QR login started',
      context: { scope: 'messaging.qr_login', botId: botId },
    });
    return result;
  }

  /** Wait for QR scan confirmation */
  async loginWithQrWait(botId: string, channelType: string): Promise<QrLoginWaitResult> {
    const connector = this.createBuiltinConnectorFor(botId, channelType);
    if (!connector?.loginWithQrWait) {
      throw new Error('Channel does not support QR login (loginWithQrWait not implemented)');
    }
    const result = await connector.loginWithQrWait({ accountId: botId, timeoutMs: 120_000 });
    appLog.info({
      event: 'messaging.qr_login.wait.completed',
      message: 'QR login wait completed',
      context: { scope: 'messaging.qr_login', botId: botId, connected: result.connected },
    });

    // Account identity is runtime state, not a user-editable Bot configuration field.
    const rawPluginAccountId = (result as { accountId?: string }).accountId;
    if (result.connected && rawPluginAccountId) {
      const botConfig = this.botConfigs.find((b) => b.id === botId);
      if (botConfig) {
        botConfig.pluginAccountId = rawPluginAccountId;
        this.accountSessions.set(botId, rawPluginAccountId);
      }
    }

    return result;
  }

  /** Submit the numeric continuation requested by the active QR session. */
  async loginWithQrSubmitCode(
    botId: string,
    channelType: string,
    code: string
  ): Promise<QrLoginSubmitCodeResult> {
    const normalizedCode = code.trim();
    if (!/^\d{1,8}$/.test(normalizedCode)) {
      throw new Error('验证码必须是 1 到 8 位数字');
    }
    const connector = this.createBuiltinConnectorFor(botId, channelType);
    if (!connector?.loginWithQrSubmitCode) {
      throw new Error('Channel does not support QR verification codes');
    }
    return connector.loginWithQrSubmitCode({ accountId: botId, code: normalizedCode });
  }

  /** Cancel and release an active QR long poll without stopping the Bot. */
  async loginWithQrCancel(botId: string, channelType: string): Promise<QrLoginCancelResult> {
    const connector = this.createBuiltinConnectorFor(botId, channelType);
    if (!connector?.loginWithQrCancel) {
      throw new Error('Channel does not support QR login cancellation');
    }
    return connector.loginWithQrCancel({ accountId: botId });
  }

  /** Logout account — stop bot and clear saved credentials */
  async logoutAccount(botId: string): Promise<LogoutResult> {
    const config = this.botConfigs.find((b) => b.id === botId);
    if (!config) throw new Error(`Bot config not found: ${botId}`);

    if (!this.accountManager.isConnectorQuiescent(botId)) {
      await this.stopBot(botId);
    }

    const connector = channelRegistry.create(config);
    if (!connector?.logoutAccount) {
      throw new Error('Channel does not support logout (logoutAccount not implemented)');
    }
    const result = await connector.logoutAccount({ accountId: botId });
    if (result.cleared && config.pluginAccountId) {
      delete config.pluginAccountId;
      this.accountSessions.delete(botId);
    }
    appLog.info({
      event: 'messaging.account.logout.completed',
      message: 'Messaging account logged out',
      context: {
        scope: 'messaging.account',
        botId: botId,
        credentialsCleared: result.cleared,
      },
    });
    return result;
  }

  /** Get all bot states (config + runtime status) */
  getBotStates(): BotState[] {
    const states: BotState[] = [];
    const runtimeStates = this.accountManager.getAllBotStates();

    for (const config of this.botConfigs) {
      const runtimeState = runtimeStates.get(config.id);
      let state = runtimeState ?? { config, status: 'stopped' as BotStatus };
      if (
        this.accountManager.isConnectorQuiescent(config.id) &&
        this.isTaskDefinitionUnavailable(config)
      ) {
        state = {
          config,
          status: 'error' as BotStatus,
          error: this.describeUnavailableTaskDefinition(config),
        };
      }
      states.push(state);
    }

    return states;
  }

  // ==================================================================
  // Sender authorization / pairing
  // ==================================================================

  /** List pending sender authorization requests. */
  listSenderAuthorizationRequests(): SenderAuthorizationRequest[] {
    return this.senderAuthorizationRegistry.listRequests();
  }

  /** Approve a pending sender authorization request. */
  approveSenderAuthorization(requestId: string): void {
    this.senderAuthorizationRegistry.approve(requestId);
  }

  /** Reject a pending sender authorization request. */
  rejectSenderAuthorization(requestId: string): void {
    this.senderAuthorizationRegistry.reject(requestId);
  }

  /** List authorized users */
  listAuthorizedUsers(): AuthorizedUser[] {
    return this.senderAuthorizationRegistry.listUsers();
  }

  /** Add an authorized user manually */
  addAuthorizedUser(botId: string, senderId: string, senderName?: string): void {
    this.senderAuthorizationRegistry.authorizeSender(botId, senderId, senderName);
  }

  /** Remove an authorized user */
  removeAuthorizedUser(botId: string, senderId: string): void {
    this.senderAuthorizationRegistry.removeUser(botId, senderId);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const imGateway = new IMGateway();
