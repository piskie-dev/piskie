import type { ConfigHost } from '../../config/host/config-host.js';
import {
  applyConfigPatch,
  escapeConfigPointer,
  patchConfigFields,
} from '../../config/host/config-mutations.js';
import type { IMGateway } from '../../im-gateway/index.js';
import type { MessagingConnectionConfig } from '../../../shared/types/im-gateway.js';
import type {
  MessagingConnectionState,
  MessagingConnectionChangedEvent,
  SaveMessagingConnectionRequest,
} from '../../../shared/electron-contracts/messaging.js';
import { PublicOperationError } from '../public-errors.js';

export class MessagingApplication {
  constructor(private readonly dependencies: {
    config: ConfigHost;
    gateway: IMGateway;
  }) {}

  listConnectors() {
    return this.dependencies.gateway.listConnectors();
  }

  async saveBot(config: SaveMessagingConnectionRequest): Promise<void> {
    const current = await this.dependencies.config.show<{
      revision: number;
      bots: Record<string, Record<string, unknown>>;
      agentBindings: Record<string, unknown>;
    }>('im-bots');
    const existing = current.bots[config.id];
    if (!existing) {
      const appSecret = config.channelType === 'openclaw-weixin'
        ? ''
        : config.appSecret;
      if (config.channelType !== 'openclaw-weixin' && !appSecret) {
        throw new PublicOperationError('invalid-input', 'A credential is required for this Bot');
      }
      const { id } = config;
      const value: Record<string, unknown> = { ...config, appSecret };
      delete value.id;
      delete value.pluginAccountId;
      await applyConfigPatch(this.dependencies.config, 'im-bots', [{
        op: 'add',
        path: `/bots/${escapeConfigPointer(id)}`,
        value,
      }], current.revision);
      return;
    }
    const updates = { ...config } as Record<string, unknown>;
    if (!config.appSecret) delete updates.appSecret;
    const patch = patchConfigFields(
      `/bots/${escapeConfigPointer(config.id)}`,
      existing,
      updates,
      new Set([
        'channelType',
        'name',
        'definitionId',
        'replyForward',
        'appId',
        'appSecret',
        'corpId',
        'agentId',
        'dmPolicy',
        'allowFrom',
        'groupPolicy',
        'groupAllowFrom',
        'groupSenderAllowFrom',
        'requireMention',
      ]),
    );
    if (existing.definitionId !== config.definitionId
      && Object.hasOwn(current.agentBindings, config.id)) {
      patch.push({
        op: 'remove',
        path: `/agentBindings/${escapeConfigPointer(config.id)}`,
      });
    }
    await applyConfigPatch(this.dependencies.config, 'im-bots', patch, current.revision);
  }

  async deleteBot(botId: string): Promise<void> {
    const current = await this.dependencies.config.show<{
      revision: number;
      bots: Record<string, unknown>;
      agentBindings: Record<string, unknown>;
    }>('im-bots');
    if (!current.bots[botId]) throw new PublicOperationError('not-found', 'Bot was not found');
    const patch = [{
      op: 'remove',
      path: `/bots/${escapeConfigPointer(botId)}`,
    }] as import('../../../shared/types/config.js').ConfigPatchOperation[];
    if (Object.hasOwn(current.agentBindings, botId)) patch.push({
      op: 'remove',
      path: `/agentBindings/${escapeConfigPointer(botId)}`,
    });
    await applyConfigPatch(this.dependencies.config, 'im-bots', patch, current.revision);
  }

  startBot(botId: string): Promise<void> {
    return this.dependencies.gateway.startBot(botId);
  }

  stopBot(botId: string): Promise<void> {
    return this.dependencies.gateway.stopBot(botId);
  }

  async status(): Promise<{
    botStates: MessagingConnectionState[];
    configs: MessagingConnectionConfig[];
  }> {
    const visible = await this.dependencies.config.show<{
      bots: Record<string, Record<string, unknown>>;
    }>('im-bots');
    const privateConfigs = Object.entries(visible.bots)
      .map(([id, config]) => toMessagingConfig(id, config));
    const stateById = new Map(
      this.dependencies.gateway.getBotStates().map((state) => [state.config.id, state]),
    );
    const botStates = privateConfigs.map((config) => {
      const runtime = stateById.get(config.id);
      return {
        config: structuredClone(config),
        status: runtime?.status ?? 'stopped',
        ...(runtime?.error && { error: runtime.error }),
        ...(runtime?.startedAt && { startedAt: runtime.startedAt }),
      };
    });
    return {
      botStates,
      configs: structuredClone(privateConfigs),
    };
  }

  pendingAuthorization() {
    return this.dependencies.gateway.listSenderAuthorizationRequests();
  }

  approve(requestId: string): void {
    this.dependencies.gateway.approveSenderAuthorization(requestId);
  }

  reject(requestId: string): void {
    this.dependencies.gateway.rejectSenderAuthorization(requestId);
  }

  authorizedUsers() {
    return this.dependencies.gateway.listAuthorizedUsers();
  }

  addAuthorizedUser(botId: string, senderId: string, senderName?: string): void {
    this.dependencies.gateway.addAuthorizedUser(botId, senderId, senderName);
  }

  removeAuthorizedUser(botId: string, senderId: string): void {
    this.dependencies.gateway.removeAuthorizedUser(botId, senderId);
  }

  startQrLogin(botId: string, channelType: string, force?: boolean) {
    return this.dependencies.gateway.loginWithQrStart(botId, channelType, force);
  }

  waitForQrLogin(botId: string, channelType: string) {
    return this.dependencies.gateway.loginWithQrWait(botId, channelType);
  }

  submitQrCode(botId: string, channelType: string, code: string) {
    return this.dependencies.gateway.loginWithQrSubmitCode(botId, channelType, code);
  }

  cancelQrLogin(botId: string, channelType: string) {
    return this.dependencies.gateway.loginWithQrCancel(botId, channelType);
  }

  logoutAccount(botId: string) {
    return this.dependencies.gateway.logoutAccount(botId);
  }

  subscribeStatus(
    listener: (event: MessagingConnectionChangedEvent) => void,
    signal: AbortSignal,
  ): () => void {
    return this.dependencies.gateway.statusChanges.subscribe(
      (event) => listener(structuredClone(event)),
      { signal },
    );
  }

  subscribeAuthorization(
    listener: Parameters<IMGateway['authorizationRequests']['subscribe']>[0],
    signal: AbortSignal,
  ): () => void {
    return this.dependencies.gateway.authorizationRequests.subscribe(listener, { signal });
  }
}

function toMessagingConfig(
  id: string,
  projected: Record<string, unknown>,
): MessagingConnectionConfig {
  const config = { ...projected };
  delete config.status;
  delete config.error;
  delete config.startedAt;
  return { id, ...config } as unknown as MessagingConnectionConfig;
}
