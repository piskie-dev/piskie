import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * OpenClawRuntimeHost — vendor 渠道代码消费的 openclaw runtime 本地宿主（渠道参数化）
 *
 * lark/qqbot 上游代码经模块级 setRuntime 静态缝消费宿主能力，无法像 wecom 那样做
 * 参数穿线。本类以 openclaw 接口形状提供这些宿主能力，按渠道实例化，桥接到
 * InboundPipeline。openclaw 形状只存在于各渠道 vendor 边界内的兼容层
 *（终态在渠道内重构时消灭）。
 *
 * 机制说明：
 * - 多 bot：activeBots 以 accountId（= bot.id）注册 ConnectorContext
 * - 路由：resolveAgentRoute 缓存 routeContexts；dispatchReplyFromConfig 对
 *   `...:thread:<id>` 后缀做基础 key 回退（否则话题消息 miss 缓存）
 * - 分发：经 ctx.dispatchWithQueue 复用框架管线（实例路由/待答问题/等回合结束）
 */

import { chunkText } from './text-utils.js';
import { normalizeAccountId } from './openclaw-compat/account-id.js';
import { createHash } from 'node:crypto';
import { MEDIA_READ_FAILED_REPLY, cleanupInboundMedia } from './inbound-media.js';
import { deliverDirectFinalReply } from './direct-reply-delivery.js';
import { createDeliveryQueue, type DeliveryQueue } from './outbound.js';
import type {
  ConnectorContext,
  DeliverPayload,
  DeliverKind,
  InboundMediaFile,
  InboundMessage,
} from './channel-connector.js';

interface RouteContext {
  accountId: string;
  peer: { kind: string; id: string };
}

type HostDispatcher = DeliveryQueue;

function deriveVendorAgentKey(
  channel: string,
  botId: string,
  peerKind: 'direct' | 'group',
  peerId: string
): string {
  const naturalConversation = JSON.stringify([channel, botId, peerKind, peerId]);
  return `im-${createHash('sha256').update(naturalConversation).digest('base64url')}`;
}

export class OpenClawRuntimeHost {
  /** 渠道 key（channel-descriptors 的 channelKey，如 feishu/qqbot） */
  private readonly channel: string;

  constructor(channel: string) {
    this.channel = channel;
  }

  /** accountId（bot.id）→ 活跃连接上下文 */
  private activeBots = new Map<string, ConnectorContext>();
  /** sessionKey（基础，不含 thread 后缀）→ 路由上下文 */
  private routeContexts = new Map<string, RouteContext>();
  private runtimeObject: Record<string, unknown> | null = null;

  register(ctx: ConnectorContext): void {
    this.activeBots.set(ctx.bot.id, ctx);
  }

  unregister(botId: string): void {
    this.activeBots.delete(botId);
    for (const [key, rc] of this.routeContexts) {
      if (rc.accountId === botId) this.routeContexts.delete(key);
    }
  }

  private findCtx(accountId: string): ConnectorContext | undefined {
    const direct = this.activeBots.get(accountId);
    if (direct) return direct;
    const normalized = accountId.toLowerCase();
    for (const c of this.activeBots.values()) {
      // vendor 侧可能对 accountId 做过 normalize（小写化）
      if (c.bot.id.toLowerCase() === normalized) return c;
      // QR 渠道（weixin）：凭证按插件真实账号 ID 解析，协议层以其规整形态作为运行
      // accountId（如 a8a92220f55a@im.bot → a8a92220f55a-im-bot）——与旧
      // ChannelRuntimeAdapter.findBotConfig 的 pluginAccountId 兜底匹配一致
      const pid = c.bot.pluginAccountId;
      if (pid && normalizeAccountId(pid) === normalized) return c;
    }
    return undefined;
  }

  /** vendor 代码消费的 openclaw runtime 对象（幂等构建） */
  buildRuntime(): Record<string, unknown> {
    if (this.runtimeObject) return this.runtimeObject;
    this.runtimeObject = {
      version: '2026.3.24',
      log: (..._args: unknown[]) => undefined,
      error: (..._args: unknown[]) => undefined,
      channel: {
        reply: this.buildReplyNamespace(),
        routing: this.buildRoutingNamespace(),
        text: this.buildTextNamespace(),
        pairing: this.buildPairingNamespace(),
        media: this.buildMediaNamespace(),
        groups: createVendorGroupContracts(),
        commands: {
          shouldComputeCommandAuthorized: () => false,
          resolveCommandAuthorizedFromAuthorizers: () => false,
          isControlCommandMessage: () => false,
          shouldHandleTextCommands: () => false,
        },
        debounce: {
          resolveInboundDebounceMs: () => 1000,
        },
        session: {
          resolveStorePath: () => '',
          readSessionUpdatedAt: () => 0,
          recordInboundSession: () => {},
          updateLastRoute: () => {},
        },
        mentions: {
          buildMentionRegexes: () => [],
          matchesMentionPatterns: () => false,
          matchesMentionWithExplicit: () => false,
          resolveRequireMention: () => true,
        },
        activity: { recordChannelActivity: () => {}, record: () => {} },
        reactions: { shouldAckReaction: () => false },
        line: {},
      },
      config: {
        // vendor 的 ctx.cfg getter 每次访问都调 loadConfig，必须返回新鲜配置
        loadConfig: () => this.loadConfig(),
        writeConfigFile: () => {},
      },
      logging: {
        createLogger: (name: string) => buildNamedLogger(name),
        getChildLogger: (opts: { subsystem: string }) =>
          buildNamedLogger(opts?.subsystem ?? this.channel),
      },
      state: { resolveStateDir: () => '' },
      media: {
        // media-resolver.js 消费：core.media.detectMime({ buffer })
        detectMime: async (opts: { buffer?: Buffer }) => {
          try {
            const { fileTypeFromBuffer } = await import('file-type');
            if (!opts?.buffer) return undefined;
            return (await fileTypeFromBuffer(opts.buffer))?.mime;
          } catch {
            return undefined;
          }
        },
        upload: async () => null,
        download: async () => null,
      },
      system: {
        // dispatch-context.js 的群聊系统事件上报——PISKIE 无 openclaw 系统事件总线，忽略
        enqueueSystemEvent: () => {},
      },
      agent: buildNoopProxy('agent'),
      events: { emit: () => {}, on: () => ({ off: () => {} }), off: () => {} },
    };
    return this.runtimeObject;
  }

  /**
   * OpenClawConfig 形状的配置（活跃 bot 每次临时投影），vendor 账户解析器从中读取。
   * 多 Bot 配置按账户隔离：账密与全部准入策略一起写入各自
   * `accounts[vendorAccountKey]`，channel 顶层不再写会被遍历循环覆盖的 per-bot 字段。
   * vendorAccountKey 遵循 vendor 账户 key 规整规则（feishu getLarkAccount / qqbot
   * resolveAccountId 均小写规整），只用于配置查找；运行时路由仍使用原始 bot.id。
   */
  loadConfig(): Record<string, unknown> {
    const accounts: Record<string, unknown> = {};
    const channelCfg: Record<string, unknown> = { accounts };
    for (const ctx of this.activeBots.values()) {
      const bot = ctx.bot;
      // 凭证字段映射与旧 ConfigAdapter 一致：qqbot 的 secret 字段名为 clientSecret
      const credentials =
        this.channel === 'qqbot'
          ? { appId: bot.appId, clientSecret: bot.appSecret }
          : { appId: bot.appId, appSecret: bot.appSecret };
      const vendorAccountKey = normalizeAccountId(bot.id) || bot.id;
      accounts[vendorAccountKey] = {
        ...credentials,
        dmPolicy: bot.dmPolicy,
        allowFrom: bot.allowFrom,
        groupPolicy: bot.groupPolicy,
        groupAllowFrom: bot.groupAllowFrom,
        groupSenderAllowFrom: bot.groupSenderAllowFrom,
        requireMention: bot.requireMention,
      };
    }
    if (this.channel === 'openclaw-weixin') {
      channelCfg.replyProgressMessages = false;
    }
    return { channels: { [this.channel]: channelCfg } };
  }

  // ── reply ────────────────────────────────────────────────────────────

  private buildReplyNamespace() {
    return {
      dispatchReplyFromConfig: async (params: {
        ctx?: Record<string, unknown>;
        dispatcher?: HostDispatcher;
      }) => {
        const { ctx: inboundCtx, dispatcher } = params ?? {};
        const emptyResult = { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
        // 媒体先规整、再走任何早退：
        // - MediaPaths/MediaTypes 并行数组按序配对成 InboundMediaFile[]（类型只是提示）
        // - vendor 只有单数 MediaPath/MediaType 时也形成一条记录，不静默丢失
        // - 渠道已落盘的受管文件在所有早退出口统一清理（越界路径 cleanup 内部拒删）
        const mediaPaths =
          Array.isArray(inboundCtx?.MediaPaths) && (inboundCtx.MediaPaths as unknown[]).length
            ? (inboundCtx.MediaPaths as unknown[]).map(String)
            : inboundCtx?.MediaPath
              ? [String(inboundCtx.MediaPath)]
              : [];
        const mediaTypes = Array.isArray(inboundCtx?.MediaTypes)
          ? (inboundCtx.MediaTypes as unknown[]).map((t) => (t == null ? undefined : String(t)))
          : inboundCtx?.MediaType
            ? [String(inboundCtx.MediaType)]
            : [];
        const media: InboundMediaFile[] = mediaPaths.map((p, i) => ({
          path: p,
          declaredMediaType: mediaTypes[i],
        }));
        // MediaUrl(s) 条目分类：只有 http(s):// 才是需要当前渠道下载的远程
        // URL；feishu 等 vendor 会把本地路径同时填进 MediaPaths 和 MediaUrls，非
        // http(s) 条目一律按本地路径处理并与 MediaPaths 去重，绝不交给 fetch
        const mediaUrls =
          Array.isArray(inboundCtx?.MediaUrls) && (inboundCtx.MediaUrls as unknown[]).length
            ? (inboundCtx.MediaUrls as unknown[]).map(String)
            : inboundCtx?.MediaUrl
              ? [String(inboundCtx.MediaUrl)]
              : [];
        const knownPaths = new Set(mediaPaths);
        const remoteUrls: string[] = [];
        for (const entry of mediaUrls) {
          if (/^https?:\/\//i.test(entry)) {
            remoteUrls.push(entry);
          } else if (!knownPaths.has(entry)) {
            knownPaths.add(entry);
            media.push({ path: entry, declaredMediaType: undefined });
          }
        }
        const sessionKey = String(inboundCtx?.SessionKey ?? '');
        if (!sessionKey || !dispatcher) {
          appLog.warn({
            event: 'messaging.inbound.dispatch.rejected',
            message: 'Inbound message rejected',
            context: { scope: 'messaging.inbound', reason: 'session_unavailable' },
          });
          await cleanupInboundMedia(media);
          return emptyResult;
        }
        // 话题消息带 `:thread:<id>` 后缀，回退到基础 key 查路由
        const baseKey = sessionKey.replace(/:thread:.*$/, '');
        const routeCtx = this.routeContexts.get(baseKey);
        const connectorCtx = routeCtx ? this.findCtx(routeCtx.accountId) : undefined;
        if (!routeCtx || !connectorCtx) {
          appLog.warn({
            event: 'messaging.inbound.dispatch.rejected',
            message: 'Inbound message rejected',
            context: { scope: 'messaging.inbound', reason: 'route_unavailable' },
          });
          await cleanupInboundMedia(media);
          return emptyResult;
        }
        const messageText = String(inboundCtx?.BodyForAgent ?? inboundCtx?.Body ?? '');
        // 统一失败出口：媒体获取失败必须整条明确失败，不伪装成无附件
        // 文本；dispatch 未被调用，所有权未移交：本地清理本次已落盘的受管文件
        const failWholeMessage = async (reply: string) => {
          await cleanupInboundMedia(media);
          const direct = await deliverDirectFinalReply({ text: reply }, dispatcher);
          return { queuedFinal: direct.counts.final > 0, counts: direct.counts };
        };
        // 远程 MediaUrl(s) 必须先由当前渠道下载落到受管目录再 dispatch；
        // 下载失败返回明确错误回执，不把带媒体的消息降级为无附件文本
        for (const url of remoteUrls) {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buffer = Buffer.from(await res.arrayBuffer());
            const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || undefined;
            const saved = await connectorCtx.media.saveBuffer(buffer, contentType, 'inbound');
            media.push({ path: saved.path, declaredMediaType: saved.contentType ?? contentType });
          } catch (error) {
            appLog.error({
              event: 'messaging.inbound_media.fetch.failed',
              message: 'Inbound media download failed',
              context: { scope: 'messaging.inbound_media', accountId: connectorCtx.bot.id },
              error,
            });
            return failWholeMessage(MEDIA_READ_FAILED_REPLY);
          }
        }
        // 受管目录之外的本地路径（含 download-failed:// 哨兵）核心层绝不
        // realpath/stat/readFile/复制/删除（越界拒绝）：原样移交 Pipeline，
        // 由 validateAndConvertInboundMedia 单点 realpath 校验并整条明确拒绝
        if (!messageText && media.length === 0) {
          appLog.warn({
            event: 'messaging.inbound.dispatch.rejected',
            message: 'Inbound message rejected',
            context: { scope: 'messaging.inbound', reason: 'empty_message' },
          });
          return emptyResult;
        }
        const msg: InboundMessage = {
          peer: {
            kind: routeCtx.peer.kind === 'group' ? 'group' : 'direct',
            id: routeCtx.peer.id,
          },
          senderId: String(inboundCtx?.SenderId ?? ''),
          senderName: inboundCtx?.SenderName ? String(inboundCtx.SenderName) : undefined,
          text: messageText,
          messageId: inboundCtx?.MessageSid ? String(inboundCtx.MessageSid) : undefined,
          media: media.length ? media : undefined,
        };
        const result = await connectorCtx.dispatchWithQueue(msg, dispatcher);
        // queuedFinal 只由排队事实派生：不塞 Agent yield 或命令业务结果
        return { queuedFinal: result.counts.final > 0, counts: result.counts };
      },

      /** buffered-block 变体：由 dispatcherOptions 构建 dispatcher 后委托 */
      dispatchReplyWithBufferedBlockDispatcher: async (params: Record<string, unknown>) => {
        if (params.dispatcherOptions && !params.dispatcher) {
          const { dispatcher } = this.buildReplyNamespace().createReplyDispatcherWithTyping(
            params.dispatcherOptions as DispatcherOptions
          );
          params.dispatcher = dispatcher;
        }
        return this.buildReplyNamespace().dispatchReplyFromConfig(
          params as { ctx?: Record<string, unknown>; dispatcher?: HostDispatcher }
        );
      },

      createReplyDispatcherWithTyping: (options: DispatcherOptions) =>
        buildVendorReplyDispatcher(options),

      withReplyDispatcher: executeVendorReply,

      /** 进站上下文归一化，保持 vendor 兼容语义。 */
      finalizeInboundContext: normalizeVendorInboundContext,

      formatAgentEnvelope: renderVendorEnvelope,

      resolveEnvelopeFormatOptions: (cfg: Record<string, unknown> | undefined) => {
        const defaults = (cfg as { agents?: { defaults?: Record<string, unknown> } })?.agents
          ?.defaults;
        return {
          timezone: defaults?.envelopeTimezone,
          includeTimestamp: defaults?.envelopeTimestamp !== 'off',
          includeElapsed: defaults?.envelopeElapsed !== 'off',
          userTimezone: defaults?.userTimezone,
        };
      },

      resolveHumanDelayConfig: () => undefined,

      resolveEffectiveMessagesConfig: (cfg: Record<string, unknown> | undefined) => ({
        messagePrefix:
          (cfg as { messages?: { messagePrefix?: string } })?.messages?.messagePrefix ?? '',
        responsePrefix: (cfg as { messages?: { responsePrefix?: string } })?.messages
          ?.responsePrefix,
      }),

      formatInboundEnvelope: () => '',
    };
  }

  // ── routing ──────────────────────────────────────────────────────────

  private buildRoutingNamespace() {
    return {
      /**
       * vendor 的 `route.agentId` 无法改名，因此在此边界瞬时派生会话键；
       * 它不是核心 Agent agentId，也不参与持久化。真实顶层 agentId 由后续
       * InboundPipeline 从 IM 绑定解析。
       * peer 无效（kind 非 direct/group、id 缺失或 vendor 占位 'unknown'）时沿用
       * 空路由失败形状，不生成会让无关消息碰撞的 vendor session key。
       */
      resolveAgentRoute: (input: {
        channel?: string;
        accountId?: string;
        peer?: { kind?: string; id?: string };
      }) => {
        const accountId = String(input?.accountId ?? '');
        // 返回空 agentId 的对象而非 null：vendor 调用方（weixin process-message 等）
        // 对 route.agentId 为空有优雅跳过路径，对 null 会直接崩（读 .agentId）
        const emptyRoute = {
          agentId: undefined,
          channel: this.channel,
          accountId,
          sessionKey: undefined,
          mainSessionKey: undefined,
          lastRoutePolicy: 'session',
          matchedBy: 'none',
        };
        const ctx = this.findCtx(accountId);
        if (!ctx) {
          appLog.warn({
            event: 'messaging.route.resolve.rejected',
            message: 'Messaging route rejected',
            context: { scope: 'messaging.route', accountId, reason: 'account_unavailable' },
          });
          return emptyRoute;
        }
        const rawKind = input?.peer?.kind;
        const peerKind: 'direct' | 'group' | undefined =
          rawKind === 'direct' || rawKind === 'dm'
            ? 'direct'
            : rawKind === 'group'
              ? 'group'
              : undefined;
        const peerId = typeof input?.peer?.id === 'string' ? input.peer.id : '';
        if (!peerKind || !peerId.trim() || peerId === 'unknown') {
          appLog.warn({
            event: 'messaging.route.resolve.rejected',
            message: 'Messaging route rejected',
            context: {
              scope: 'messaging.route',
              accountId,
              reason: 'invalid_peer',
            },
          });
          return emptyRoute;
        }
        const vendorAgentKey = deriveVendorAgentKey(this.channel, ctx.bot.id, peerKind, peerId);
        const vendorSessionKey = `agent:${vendorAgentKey}:${this.channel}:${peerKind}:${peerId}`;
        this.routeContexts.set(vendorSessionKey, {
          accountId: ctx.bot.id,
          peer: { kind: peerKind, id: peerId },
        });
        return {
          agentId: vendorAgentKey,
          channel: this.channel,
          accountId,
          sessionKey: vendorSessionKey,
          mainSessionKey: `agent:${vendorAgentKey}:main`,
          lastRoutePolicy: 'session',
          matchedBy: 'binding.account',
        };
      },
    };
  }

  // ── text（基于共享 text-utils）──────────────────────────

  private buildTextNamespace() {
    return {
      hasControlCommand: () => false,
      resolveChunkMode: () => 'length',
      resolveTextChunkLimit: resolveVendorChunkLimit,
      resolveMarkdownTableMode: (params: { channel?: string }) =>
        params?.channel ? 'code' : 'code',
      convertMarkdownTables: (text: string) => text || '',
      chunkMarkdownText: (text: string, limit: number) => chunkText(text, limit),
      chunkTextWithMode: (text: string, limit: number) => chunkText(text, limit),
    };
  }

  // ── pairing（桥接框架 PairingApi）─────────────────────────────────────

  private buildPairingNamespace() {
    return {
      buildPairingReply: (params: { idLine?: string; code?: string }) =>
        `${params?.idLine || ''}\n配对码: ${params?.code || '000000'}\n请联系管理员完成授权。`,

      // feishu gate.js 使用对象签名 ({channel, accountId})；旧位置参数签名 (channel, env, accountId) 兜底
      readAllowFromStore: async (
        params: { accountId?: string } | string,
        _env?: unknown,
        positionalAccountId?: string
      ) => {
        const accountId =
          typeof params === 'object' && params !== null ? params.accountId : positionalAccountId;
        const ctx = accountId ? this.findCtx(String(accountId)) : [...this.activeBots.values()][0];
        return ctx?.pairing.getAllowedSenders() ?? [];
      },

      upsertPairingRequest: async (params: {
        accountId?: string;
        id?: string;
        senderId?: string;
        senderName?: string;
        peerType?: 'dm' | 'group';
        peerId?: string;
        meta?: { name?: string };
      }) => {
        const ctx = params?.accountId
          ? this.findCtx(String(params.accountId))
          : [...this.activeBots.values()][0];
        if (!ctx) return { code: '000000', created: false };
        const senderId = params?.senderId || params?.id || '';
        return ctx.pairing.request({
          senderId,
          senderName: params?.senderName || params?.meta?.name || senderId,
          peerType: params?.peerType || 'dm',
          peerId: params?.peerId || senderId,
        });
      },
    };
  }

  // ── media ────────────────────────────────────────────────────────────

  private buildMediaNamespace() {
    return {
      // contentType 诚实可选：vendor 无法预判 MIME 时以 undefined 调用
      saveMediaBuffer: async (
        buffer: Buffer,
        contentType?: string,
        subdir?: string,
        maxBytes?: number,
        filename?: string
      ) => {
        const ctx = [...this.activeBots.values()][0];
        if (!ctx) throw new Error('No active feishu bot');
        return ctx.media.saveBuffer(buffer, contentType, subdir, maxBytes, filename);
      },

      // qqbot inbound-attachments 消费：入站附件下载后直接经
      // ConnectorContext.media.saveBuffer 落受管目录（os.tmpdir()/piskie-media），
      // 不经 vendor 自有目录（~/.openclaw/media）——核心层绝不读取受管目录外的路径
      saveInboundMediaBuffer: async (opts: {
        accountId?: string;
        buffer: Buffer;
        contentType?: string;
      }) => {
        const ctx =
          (opts?.accountId ? this.findCtx(String(opts.accountId)) : undefined) ??
          [...this.activeBots.values()][0];
        if (!ctx) throw new Error(`No active ${this.channel} bot`);
        return ctx.media.saveBuffer(opts.buffer, opts.contentType, 'inbound');
      },
    };
  }
}

type ChannelSection = {
  accounts?: Record<string, { textChunkLimit?: number }>;
  textChunkLimit?: number;
};

type GroupChannelSection = {
  groupPolicy?: string;
  groups?: Record<string, unknown>;
};

type GroupPolicyInput = {
  cfg?: { channels?: Record<string, GroupChannelSection> };
  channel?: string;
  groupId?: string;
  groupIdCaseInsensitive?: boolean;
  hasGroupAllowFrom?: boolean;
};

type GroupMentionInput = GroupPolicyInput & {
  requireMentionOverride?: boolean;
  overrideOrder?: string;
};

type DispatcherOptions = {
  deliver?: (payload: DeliverPayload, info: { kind: DeliverKind }) => Promise<void> | void;
  onReplyStart?: () => Promise<void> | void;
  onError?: (err: unknown, info: { kind: string }) => void;
  onIdle?: () => void;
  onCleanup?: () => void;
};

type VendorReplyExecution = {
  run: () => Promise<unknown>;
  dispatcher?: HostDispatcher;
  onSettled?: () => Promise<void> | void;
};

async function executeVendorReply(params: VendorReplyExecution): Promise<unknown> {
  try {
    return await params.run();
  } finally {
    await finishVendorReply(params.dispatcher, params.onSettled);
  }
}

async function finishVendorReply(
  dispatcher?: HostDispatcher,
  onSettled?: () => Promise<void> | void
): Promise<void> {
  dispatcher?.markComplete?.();
  try {
    await dispatcher?.waitForIdle?.();
  } finally {
    await onSettled?.();
  }
}

function normalizeVendorInboundContext(
  context: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!context) return context;

  normalizeLineEndings(context, 'Body');
  context.BodyForAgent =
    context.BodyForAgent ?? context.CommandBody ?? context.RawBody ?? context.Body ?? '';
  normalizeLineEndings(context, 'BodyForAgent');
  context.BodyForCommands =
    context.BodyForCommands ?? context.CommandBody ?? context.RawBody ?? context.Body ?? '';
  context.CommandAuthorized = context.CommandAuthorized === true;
  supplyMissingMediaTypes(context);
  return context;
}

function normalizeLineEndings(context: Record<string, unknown>, field: string): void {
  const value = context[field];
  if (typeof value === 'string') context[field] = value.replace(/\r\n?/g, '\n');
}

function supplyMissingMediaTypes(context: Record<string, unknown>): void {
  const mediaCount = Math.max(
    Array.isArray(context.MediaPaths) ? context.MediaPaths.length : 0,
    Array.isArray(context.MediaUrls) ? context.MediaUrls.length : 0,
    context.MediaPath || context.MediaUrl ? 1 : 0
  );
  const hasDeclaredTypes = Array.isArray(context.MediaTypes) && context.MediaTypes.length > 0;
  if (mediaCount === 0 || hasDeclaredTypes) return;

  const mediaType = context.MediaType || 'application/octet-stream';
  context.MediaTypes = new Array(mediaCount).fill(mediaType);
  context.MediaType = mediaType;
}

function resolveVendorChunkLimit(
  config?: Record<string, unknown>,
  provider?: string,
  accountId?: string,
  options?: { fallbackLimit?: number }
): number {
  const requestedFallback = options?.fallbackLimit;
  const fallback =
    typeof requestedFallback === 'number' && requestedFallback > 0 ? requestedFallback : 4000;
  if (!provider) return fallback;

  const channels = (config as { channels?: Record<string, ChannelSection> })?.channels;
  const section =
    channels?.[provider] ?? (config as Record<string, ChannelSection | undefined>)?.[provider];
  if (section === undefined) return fallback;

  const accountLimit = accountId ? section.accounts?.[accountId]?.textChunkLimit : undefined;
  if (typeof accountLimit === 'number') return accountLimit;
  return typeof section.textChunkLimit === 'number' ? section.textChunkLimit : fallback;
}

function createVendorGroupContracts() {
  return {
    resolveGroupPolicy: evaluateVendorGroupAccess,
    resolveRequireMention: selectVendorMentionRequirement,
  };
}

function evaluateVendorGroupAccess(params: GroupPolicyInput | null = {}) {
  const input = params || {};
  const channelConfig = input.channel ? input.cfg?.channels?.[input.channel] : undefined;
  const groups = channelConfig?.groups;
  const hasNamedGroups = Boolean(groups && Object.keys(groups).length > 0);
  const allowlistEnabled = channelConfig?.groupPolicy === 'allowlist' || hasNamedGroups;
  const groupConfig = findVendorGroupConfig(groups, input.groupId, input.groupIdCaseInsensitive);
  const defaultConfig = groups?.['*'];
  const wildcard = allowlistEnabled && Boolean(groups && Object.hasOwn(groups, '*'));
  const senderListOnly =
    channelConfig?.groupPolicy === 'allowlist' &&
    !hasNamedGroups &&
    Boolean(input.hasGroupAllowFrom);
  const allowed =
    channelConfig?.groupPolicy !== 'disabled' &&
    (!allowlistEnabled || wildcard || Boolean(groupConfig) || senderListOnly);

  return { allowlistEnabled, allowed, groupConfig, defaultConfig };
}

function findVendorGroupConfig(
  groups: Record<string, unknown> | undefined,
  groupId: string | undefined,
  caseInsensitive: boolean | undefined
): unknown {
  const key = groupId?.trim();
  if (!key || groups === undefined) return undefined;
  const exact = groups[key];
  if (exact || !caseInsensitive) return exact;
  const folded = key.toLowerCase();
  return Object.entries(groups).find(([candidate]) => candidate.toLowerCase() === folded)?.[1];
}

function selectVendorMentionRequirement(params: GroupMentionInput | null = {}): boolean {
  const input = params || {};
  const access = evaluateVendorGroupAccess(input);
  const configured =
    booleanProperty(access.groupConfig, 'requireMention') ??
    booleanProperty(access.defaultConfig, 'requireMention');
  const override = input.requireMentionOverride;

  if (input.overrideOrder === 'before-config' && typeof override === 'boolean') return override;
  if (configured !== undefined) return configured;
  if (input.overrideOrder !== 'before-config' && typeof override === 'boolean') return override;
  return true;
}

function booleanProperty(value: unknown, field: string): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'boolean' ? candidate : undefined;
}

/** 将 OpenClaw vendor 形状适配到唯一的框架投递队列。 */
function buildVendorReplyDispatcher(options: DispatcherOptions) {
  const dispatcher = createDeliveryQueue({
    deliver: async (payload, info) => {
      await options.deliver?.(payload, info);
    },
    onReplyStart: options.onReplyStart,
    onError: options.onError,
    onIdle: options.onIdle,
  });

  return {
    dispatcher,
    replyOptions: {
      onReplyStart: options.onReplyStart,
      onTypingCleanup: options.onCleanup,
      onTypingController: () => {},
    },
    markDispatchIdle: () => {
      if (options.onIdle) {
        try {
          options.onIdle();
        } catch {
          /* 忽略 */
        }
      }
    },
    markRunComplete: () => {},
  };
}

/** 消息信封格式化，保持 vendor 兼容语义。 */
function renderVendorEnvelope(params: Record<string, unknown>): string {
  const parts = [cleanEnvelopeLabel(String(params?.channel || 'Channel'))];
  const body = params?.body || params?.text || params?.content || '';
  const elapsed =
    params?.timestamp && params?.previousTimestamp
      ? elapsedEnvelopeLabel(params.timestamp, params.previousTimestamp)
      : undefined;

  const from = typeof params?.from === 'string' ? params.from.trim() : '';
  if (from) {
    const sender = cleanEnvelopeLabel(from);
    parts.push(elapsed ? `${sender} +${elapsed}` : sender);
  } else if (elapsed) {
    parts.push(`+${elapsed}`);
  }

  for (const field of ['host', 'ip'] as const) {
    const value = typeof params?.[field] === 'string' ? params[field].trim() : '';
    if (value) parts.push(cleanEnvelopeLabel(value));
  }

  const ts = params?.timestamp;
  const envelope = params?.envelope as { includeTimestamp?: boolean } | undefined;
  if (ts && envelope?.includeTimestamp !== false) {
    const timestamp = timestampEnvelopeLabel(ts);
    if (timestamp) parts.push(timestamp);
  }

  return `[${parts.join(' ')}] ${body}`;
}

function cleanEnvelopeLabel(value: string): string {
  return value
    .replace(/[[\]\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function elapsedEnvelopeLabel(current: unknown, previous: unknown): string | undefined {
  const currentTime = current instanceof Date ? current.getTime() : Number(current);
  const previousTime = previous instanceof Date ? previous.getTime() : Number(previous);
  const elapsed = currentTime - previousTime;
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined;
  if (elapsed < 60_000) return `${Math.round(elapsed / 1_000)}s`;
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m`;
  return `${Math.round(elapsed / 3_600_000)}h`;
}

function timestampEnvelopeLabel(value: unknown): string | undefined {
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) return undefined;
  try {
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date);
    const time = date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${weekday} ${time}`;
  } catch {
    return undefined;
  }
}

function buildNamedLogger(_name: string) {
  return {
    info: (..._args: unknown[]) => undefined,
    warn: (..._args: unknown[]) => undefined,
    error: (..._args: unknown[]) => undefined,
    debug: (..._args: unknown[]) => undefined,
  };
}

/** 未实现命名空间的宽容 stub（访问即 no-op，与旧 PluginRuntimeFactory 一致） */
function buildNoopProxy(_namespace: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        return () => {
          return undefined;
        };
      },
    }
  );
}
