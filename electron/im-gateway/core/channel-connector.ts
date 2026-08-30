/**
 * ChannelConnector — PISKIE IM 渠道连接器接口
 *
 * 渠道协议代码（channels/*）唯一需要实现的契约。按现系统实际使用面收敛：
 * - start(): 长驻 Promise，resolve/reject = 账号停止（AccountManager 据此做自动重启）
 * - dispatch(): 进站消息 → agent → 回复帧经 deliver 回流
 * - pairing/media: 框架提供的扫码登录与媒体能力
 */

import type {
  MessagingConnectionConfig,
  QrLoginStartResult,
  QrLoginWaitResult,
  QrLoginSubmitCodeResult,
  QrLoginCancelResult,
  LogoutResult,
} from '@shared/types/im-gateway.js';

export interface ConnectorLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export interface InboundPeer {
  kind: 'direct' | 'group';
  id: string;
}

/**
 * 一次调用内移交的受管临时媒体文件：逐文件记录取代易错位的
 * mediaPaths/mediaTypes 并行数组。declaredMediaType 只作提示与诊断，
 * 最终是否可注入由 Pipeline 的文件 magic 检测决定。
 */
export interface InboundMediaFile {
  path: string;
  declaredMediaType?: string;
}

/** 渠道解析后的进站消息（归一化由 connector 完成，框架不再做二次兜底） */
export interface InboundMessage {
  peer: InboundPeer;
  senderId: string;
  senderName?: string;
  text: string;
  messageId?: string;
  /** 引用消息内容（用户仅 @ 机器人时可作为正文） */
  quotedText?: string;
  /**
   * 已落盘的受管临时媒体文件（下载由渠道协议层完成）。一次调用内的运输输入，
   * 不是会话状态；调用 dispatch()/dispatchWithQueue() 后删除责任移交 Pipeline。
   */
  media?: InboundMediaFile[];
}

export type ToolProgressStatus = 'completed' | 'failed' | 'blocked';

export interface ToolProgressStart {
  toolCallId: string;
  toolName: string;
}

export interface ToolProgressComplete extends ToolProgressStart {
  status: ToolProgressStatus;
}

export interface ToolProgressFrame extends ToolProgressStart {
  phase: 'start' | 'result';
  status?: ToolProgressStatus;
}

export interface ToolProgressCapability {
  start(event: ToolProgressStart): boolean;
  complete(event: ToolProgressComplete): boolean;
  closeOpen(status: 'blocked'): number;
}

export interface DeliverPayload {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  toolProgress?: ToolProgressFrame;
}

export type DeliverKind = 'block' | 'tool' | 'final';

export interface DispatchCallbacks {
  /** 首个内容帧前回调一次（渠道可发送"思考中"占位） */
  onReplyStart?: () => void | Promise<void>;
  /** agent 内容帧回调，框架保证按序串行调用 */
  deliver: (payload: DeliverPayload, info: { kind: DeliverKind }) => Promise<void>;
  onError?: (err: unknown, info: { kind: DeliverKind }) => void;
}

export type DispatchCounts = { block: number; tool: number; final: number };

/**
 * 一次 dispatch 等待下一次 Pump yield 的结果：
 * - yield: 任意 turn_end 释放该 agentId 当时的全部 waiter
 * - timeout: 等待超时，只收尾本次 dispatch，不删 binding、不中断 Agent
 * - binding_removed: binding 被 Agent stop/state-null 或 Bot stop 删除
 */
export type DispatchYieldOutcome = 'yield' | 'timeout' | 'binding_removed';

/**
 * 本次 Connector dispatch 的运输结果——不复用命令业务成功与否：
 * - kind='agent'：普通消息路径，completion 如实返回 yield/timeout/binding_removed/
 *   inject_rejected，不收敛成布尔
 * - kind='direct'：命令与其他直接回执路径，不等待 Agent yield
 */
export type DispatchResult =
  | {
      kind: 'agent';
      completion: DispatchYieldOutcome | 'inject_rejected';
      counts: DispatchCounts;
    }
  | {
      kind: 'direct';
      counts: DispatchCounts;
    };

/**
 * ReplyDispatcher — ReplyInterceptor 与 InboundPipeline 共同消费的唯一出站能力接口
 *。`createDeliveryQueue(callbacks)` 返回它；飞书等渠道也可以在进入
 * `dispatchWithQueue()` 前提前创建（"提前创建"只描述对象产生时机，不形成第二种类型）。
 * 实现对象可以带 `dispatch()`、`getFailedCounts()` 等额外兼容方法，核心接口不依赖它们。
 */
export interface ReplyDispatcher {
  sendBlockReply(payload: DeliverPayload): boolean;
  sendToolResult(payload: DeliverPayload): boolean;
  sendFinalReply(payload: DeliverPayload): boolean;
  /** 释放本次 dispatch 的 idle 预留位（不是 dispose，不拒绝后续 enqueue） */
  markComplete(): void;
  waitForIdle(): Promise<void>;
  getQueuedCounts(): { block: number; tool: number; final: number };
  /** 渠道可选的结构化工具进度运输能力（当前仅微信实现）。 */
  toolProgress?: ToolProgressCapability;
}

/** 配对/授权能力（替代 openclaw runtime.channel.pairing，数据源为 IMGateway 授权用户表） */
export interface PairingApi {
  /** 该 bot 已授权的 senderId 列表（配对通过 + 手工添加） */
  getAllowedSenders(): string[];
  /** 创建或复用待授权请求，返回配对码 */
  request(params: {
    senderId: string;
    senderName?: string;
    peerType: 'dm' | 'group';
    peerId: string;
  }): { code: string; created: boolean };
  /** 生成配对提示文案（发回给未授权用户） */
  buildReply(params: { idLine: string; code: string }): string;
}

/**
 * 进站媒体落盘能力（替代 openclaw runtime.channel.media.saveMediaBuffer）。
 * contentType 诚实可选：JS vendor 在无法预判 MIME 时以 undefined
 * 调用；未知类型落盘用 `.bin` 或检测得到的安全扩展名。
 */
export interface MediaApi {
  saveBuffer(
    buffer: Buffer,
    contentType?: string,
    subdir?: string,
    maxBytes?: number,
    filename?: string,
  ): Promise<{ path: string; size: number; contentType?: string }>;
}

/** 框架传给 connector.start() 的上下文 */
export interface ConnectorContext {
  bot: MessagingConnectionConfig;
  /** stopBot / 应用退出时触发；connector 必须在 abort 后让 start() 的 Promise settle */
  signal: AbortSignal;
  log: ConnectorLogger;
  pairing: PairingApi;
  media: MediaApi;
  /**
   * 进站消息分发：路由到 agent 实例并注入事件，回复帧经 callbacks.deliver 回流，
   * 回合结束（turn_end）且所有 deliver 完成后 resolve。
   * shared 模式下框架对同一 agent 串行化并发消息。
   */
  dispatch(msg: InboundMessage, callbacks: DispatchCallbacks): Promise<DispatchResult>;
  /**
   * 外部预建投递队列的分发变体：渠道自带 dispatcher 构建逻辑
   * （如 feishu 的流式卡片 dispatcher）时使用；出站对象统一为 ReplyDispatcher。
   */
  dispatchWithQueue(msg: InboundMessage, dispatcher: ReplyDispatcher): Promise<DispatchResult>;
  /** 注册/清除迟到帧兜底投递（见 LateSink 说明），connector.start 内调用 */
  setLateSink(sink: LateSink | null): void;
  /** 连接器状态摘要上报（仅日志/诊断，不参与生命周期） */
  setStatus(patch: Record<string, unknown>): void;
}

export interface ChannelConnector {
  /** 渠道 ID（与 MessagingConnectionConfig.channelType / channel-descriptors 的 channelKey 一致） */
  readonly id: string;
  /**
   * 启动账号连接。返回长驻 Promise：
   * - resolve/reject = 账号已停止（AccountManager 按策略自动重启）
   * - ctx.signal abort 后必须尽快 settle（resolve 视为手动停止）
   * - 不可恢复错误（如凭证错误）可保持 pending 并 setStatus 上报，阻止无意义重启
   */
  start(ctx: ConnectorContext): Promise<void>;

  // ── 可选能力：扫码登录渠道（weixin） ──
  loginWithQrStart?(opts: { accountId: string; force?: boolean }): Promise<QrLoginStartResult>;
  loginWithQrWait?(opts: { accountId: string; timeoutMs?: number }): Promise<QrLoginWaitResult>;
  loginWithQrSubmitCode?(opts: { accountId: string; code: string }): Promise<QrLoginSubmitCodeResult>;
  loginWithQrCancel?(opts: { accountId: string }): Promise<QrLoginCancelResult>;
  logoutAccount?(opts: { accountId: string }): Promise<LogoutResult>;
}

/**
 * 迟到帧兜底投递：PISKIE agent 是多回合工作模型（应答→工具→数分钟后才出最终答案），
 * 而部分渠道（feishu 流式卡片）的 dispatcher 在进站分发窗口关闭后丢弃迟到帧。
 * 渠道经 ctx.setLateSink 注册兜底后，框架会在分发完成时把该 agent 的投递器切换为
 * 主动发送（新进站消息到达时自动换回渠道 dispatcher）。
 */
export type LateSink = (payload: DeliverPayload, peer: InboundPeer) => Promise<void>;

/** 连接器工厂：每次 startBot 创建新实例（连接状态不跨启动复用） */
export type ConnectorFactory = (bot: MessagingConnectionConfig) => ChannelConnector;
