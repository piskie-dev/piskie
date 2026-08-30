import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * Agent 单次运行的会话事实 owner。
 *
 * 保存有序消息与事件，追加持久化记录，按 provider 实测用量执行请求准入，
 * 并在越过上下文预算时用摘要替换已处理历史。
 */

import type { AgentInferencePort } from '../../inference/application/agent-inference-port.js';
import type { ModelTarget } from '../../inference/execution/contracts.js';
import { formatModelTarget } from '../../inference/execution/model-target.js';
import {
  type Message,
  type ContentBlock,
  type MessageSubtype,
  type Tool,
  type ToolResultContentBlock,
} from '../../../shared/types/index.js';
import type {
  EnhancedMessage,
  EnhancedAIContext,
  ContextSummary,
  AIRequestInfo,
} from '../../../shared/types/context.js';
import type {
  ConversationAppendMetadata,
  ConversationWriteEntry,
} from '../../../shared/types/agent-control.js';
import type {
  ContextSnapshot,
  ContextRequestTokenCheckpoint,
  ContextUsage,
} from '../../../shared/types/token.js';
import { CompactionEngine, type CompactionRequestShape } from './compaction-engine.js';
import { IMAGE_TOKEN_UPPER_BOUND, MAX_TOOL_RESULT_BYTES } from '../../../shared/constants/token.js';
import { compactionArchive } from '../../agent-runs/compaction-archive.js';

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 一条消息对 token 数的**严格上界**。
 *
 * 文本按字符数：BPE 最坏情况一字符一 token，任何 tokenizer 都不可能把 N 个字符
 * 编成多于 N 个 token。这是数学事实，不随模型版本、语种、tokenizer 换代失效——
 * 与估算的本质区别在于它的错误方向是固定的（只会保守，不会漏）。
 * 连字段名一起计入，顺带盖住消息结构本身的那点框架开销。
 *
 * base64 图片是唯一的例外：一张 1MB 的图有约 140 万字符却只值几千 token，
 * 按字符算会让每个带图轮次都掉进二级准入。改用 provider 文档写死的单张上限，
 * 同样是严格上界，但紧得多。
 */
function messageTokenUpperBound(message: Message): number {
  return valueTokenUpperBound(message.content);
}

/**
 * 单条 `tool_result` 的字节配额。
 *
 * 这是一条防御性配额，不是正确性要求，所以不需要精确到 token——
 * 量纲取精确可测的 UTF-8 字节，配额值是独立选定的策略参数，
 * **不由任何 token 比例换算而来**——那种换算本身就是估算。
 */
function truncateToolResultBlocks(blocks: ToolResultContentBlock[]): ToolResultContentBlock[] {
  return blocks.map((block) => {
    if (block.type !== 'text' || !block.text) return block;
    const truncated = truncateToBytes(block.text);
    return truncated === undefined ? block : { ...block, text: truncated };
  });
}

/** 超配额时按 UTF-8 字节截断并如实说明；未超返回 undefined。 */
function truncateToBytes(text: string): string | undefined {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_TOOL_RESULT_BYTES) return undefined;

  // 按字节切分后可能落在多字节字符中间，'utf8' 解码会把残片变成替换字符，
  // 去掉尾部这一个即可，不需要反向扫描边界。
  const head = Buffer.from(text, 'utf8')
    .subarray(0, MAX_TOOL_RESULT_BYTES)
    .toString('utf8')
    .replace(/\uFFFD$/, '');

  appLog.warn({
    event: 'agent.tool_result.truncate.completed',
    message: 'Oversized tool result was truncated',
    context: {
      scope: 'agent.tool_result',
      originalBytes: bytes,
      maxBytes: MAX_TOOL_RESULT_BYTES,
    },
  });

  return (
    head +
    `\n\n[⚠️ 结果已截断：原始 ${bytes} 字节，保留前 ${MAX_TOOL_RESULT_BYTES} 字节。` +
    '如需完整内容请使用文件操作工具写入文件后读取。]'
  );
}

function valueTokenUpperBound(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + valueTokenUpperBound(item), 0);
  }
  if (value === null || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  if (record.type === 'base64' && typeof record.data === 'string') return IMAGE_TOKEN_UPPER_BOUND;
  return Object.entries(record).reduce(
    (sum, [key, item]) => sum + key.length + valueTokenUpperBound(item),
    0
  );
}

export interface AgentConversationContextOptions {
  /** Agent 推理应用端口（用于压缩时生成摘要） */
  inference: AgentInferencePort;
  /** 当前使用的精确模型目标 */
  target: ModelTarget;
  mainAgentId?: string;
}

export interface PreparedRequestMessages {
  messages: Message[];
}

/** 压缩活动只描述可观察生命周期，不区分主动压缩和超窗恢复入口。 */
export type CompactionActivityCallback = (active: boolean) => void;

export class AgentConversationContext {
  private context: EnhancedAIContext;
  private compactionEngine: CompactionEngine;
  private inference: AgentInferencePort;
  private target: ModelTarget;
  private isCompacting: boolean = false;
  /** 当前进程内最后一次成功请求消费到的消息前缀长度。 */
  private consumedThrough = 0;
  private mainAgentId: string;
  /** 持久化 hook：pending 消息由 flush 落盘，assistant 响应同步落盘。 */
  private persistHook:
    ((entry: ConversationWriteEntry, metadata?: ConversationAppendMetadata) => void) | null = null;
  private readonly assistantRequests = new WeakMap<EnhancedMessage, string>();
  private readonly assistantInputTokens = new WeakMap<EnhancedMessage, number>();
  /** replay 期间挂起 flush，回放内容本来就来自磁盘 */
  private flushSuspended = false;
  /**
   * 上一次由 provider 做出的测量，带「用哪把尺子量的」。
   * 两个写入点：成功响应的 `usage`、`countTokens`（准入 / setTarget）。
   * 本地永远不写这个字段——没有分词器，写进去的只能是猜的。
   */
  private lastMeasurement?: { target: string; tokens: number };
  /** 测量刷新后通知外部（UI 广播）；与 setPersistHook 同一形态 */
  private measurementHook: (() => void) | null = null;
  /**
   * 自上次测量以来追加内容的 token **严格上界**。
   * recordMessage 累加、成功请求提交时归零。它不是估算：估算两个方向都会错，
   * 上界只会保守——最坏结果是多问 provider 一次，永远不会漏判溢出。
   */
  private appendedTokenUpperBound = 0;
  /** 上一次工作请求的稳定外壳；计数、压缩和 overflow 重发共用。 */
  private lastRequestShape?: CompactionRequestShape;

  constructor(options: AgentConversationContextOptions) {
    this.inference = options.inference;
    this.target = options.target;
    this.mainAgentId = options.mainAgentId ?? '_unknown';

    this.compactionEngine = new CompactionEngine(options.inference);

    this.context = this.createEmptyContext();
  }

  /**
   * 设置持久化 hook（flush / summary 落盘时调用）
   */
  setPersistHook(
    fn: (entry: ConversationWriteEntry, metadata?: ConversationAppendMetadata) => void
  ): void {
    this.persistHook = fn;
  }

  /**
   * 设置测量刷新回调。`setTarget` 里的重算是异步的，落地时冲程可能已经结束，
   * 没有这个回调界面就会停在「—」直到下一轮请求。
   */
  setMeasurementHook(fn: () => void): void {
    this.measurementHook = fn;
  }

  /** replay 开始：挂起 flush */
  beginReplay(): void {
    this.flushSuspended = true;
  }

  /** replay 结束：回放内容全部标记为已持久化，恢复 flush */
  endReplay(): void {
    for (const msg of this.context.fullMessages) {
      msg.persisted = true;
    }
    this.flushSuspended = false;
  }

  /**
   * 把内存中未持久化的 pending 消息按顺序落盘。
   * 调用时机：callAI 前 / 工具批次完成后 / 循环退出兜底。
   */
  flush(): void {
    this.flushPendingMessages(false);
  }

  private flushPendingMessages(failFast: boolean): void {
    if (this.flushSuspended || !this.persistHook) return;

    const pendingMessages = this.context.fullMessages.filter((m) => !m.persisted);
    if (pendingMessages.length === 0) return;

    for (const message of pendingMessages) {
      try {
        const requestId = this.assistantRequests.get(message);
        this.persistHook(this.messageToEntry(message), requestId ? { requestId } : undefined);
        message.persisted = true;
      } catch (error) {
        appLog.error({
          event: 'agent.conversation.persist.failed',
          message: 'Agent conversation persistence failed',
          context: { scope: 'agent.conversation', entryKind: 'msg' },
          error,
        });
        if (failFast) throw error;
        // A later message must never overtake an earlier failed write.
        return;
      }
    }
  }

  /** Ordinary Message → write entry conversion; ToolEntry belongs only to Settler. */
  private messageToEntry(msg: EnhancedMessage): ConversationWriteEntry {
    if (
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      (msg.content[0] as ContentBlock).type === 'tool_result'
    ) {
      throw new Error('Unpersisted tool_result bypassed Settler');
    }

    const base = {
      t: 'msg' as const,
      ts: msg.timestamp,
      id: msg.id,
      content: msg.content,
    };
    if (msg.role === 'user') {
      if (!msg.subtype) throw new Error('User message is missing its canonical subtype');
      return { ...base, role: 'user', subtype: msg.subtype };
    }
    return { ...base, role: 'assistant' };
  }

  private persistEntry(entry: ConversationWriteEntry): void {
    if (this.flushSuspended || !this.persistHook) return;
    try {
      this.persistHook(entry);
    } catch (error) {
      appLog.error({
        event: 'agent.conversation.persist.failed',
        message: 'Agent conversation persistence failed',
        context: { scope: 'agent.conversation', entryKind: entry.t },
        error,
      });
    }
  }

  private createEmptyContext(): EnhancedAIContext {
    return {
      summaries: [],
      fullMessages: [],
    };
  }

  /** 接受已经排好顺序的用户内容；这里不重排 block，也不合并相邻消息。 */
  addUserMessage(content: string | ContentBlock[], subtype: MessageSubtype = 'user_input'): void {
    this.recordMessage({ role: 'user', content, subtype });
  }

  /** 恢复通知必须先落盘，持久化失败时不能暴露为内存事实。 */
  addDurableUserMessage(
    content: string,
    subtype: MessageSubtype = 'system_event',
    messageId?: string
  ): void {
    if (this.flushSuspended) {
      throw new Error('Cannot append a durable message while replay is active');
    }
    if (!this.persistHook) {
      throw new Error('Cannot append a durable message without a persistence hook');
    }

    const message: Message = { role: 'user', content, subtype };
    const enhanced = this.createMessageRecord(message, messageId ? { id: messageId } : {});
    this.persistHook(this.messageToEntry(enhanced));
    enhanced.persisted = true;
    this.appendMessageRecord(enhanced);
  }

  addAssistantMessage(
    content: string | ContentBlock[],
    request?: string | Pick<AIRequestInfo, 'requestId' | 'usage'>
  ): void {
    const message: Message = { role: 'assistant', content };
    const enhanced = this.createMessageRecord(message);
    const requestId = typeof request === 'string' ? request : request?.requestId;
    if (requestId) this.assistantRequests.set(enhanced, requestId);
    const inputTokens = typeof request === 'string' ? undefined : request?.usage.inputTokens;
    if (inputTokens !== undefined) this.assistantInputTokens.set(enhanced, inputTokens);

    if (!this.flushSuspended && this.persistHook) {
      // Persist every earlier input first, then write this response before tool settlement can see it.
      this.flushPendingMessages(true);
      try {
        this.persistHook(
          this.messageToEntry(enhanced),
          requestId ? { requestId } : undefined
        );
      } catch (error) {
        appLog.error({
          event: 'agent.conversation.persist.failed',
          message: 'Agent conversation persistence failed',
          context: { scope: 'agent.conversation', entryKind: 'msg' },
          error,
        });
        throw error;
      }
      enhanced.persisted = true;
    }

    this.appendMessageRecord(enhanced);
  }

  /** Apply the existing context limit before Settler persists the exact model-facing blocks. */
  prepareToolResultBlocks(blocks: ToolResultContentBlock[]): ToolResultContentBlock[] {
    return truncateToolResultBlocks(blocks);
  }

  /** Project blocks that Settler has already persisted, without creating a second disk write. */
  appendToolResultProjection(
    toolUseId: string,
    blocks: ToolResultContentBlock[],
    ok: boolean,
    timestamp: number
  ): void {
    this.recordMessage(
      {
        role: 'user',
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: toolUseId,
            content: blocks as ToolResultContentBlock[],
            ...(ok === false ? { is_error: true } : {}),
          },
        ],
      },
      { toolResultOk: ok, timestamp, persisted: true }
    );
  }

  private projectMessages(messages: EnhancedMessage[]): Message[] {
    // 对全部消息执行请求规范化（含 processed 区）：
    // 位置归位 + payload 层确定性清理；未配对 tool_use（pending ask）原样保留
    const allMsgs = this.stripRuntimeMessageFields(messages);
    return this.normalizeToolMessagesForRequest(allMsgs);
  }

  /**
   * 工具消息请求投影：只关联 call/result，不修改 fullMessages 或普通消息边界。
   *
   * 对可唯一匹配的批次：结果紧邻对应 assistant 批次；并行结果集中一条 user 消息、
   * 顺序与 call 顺序一致；tool_result 块位于普通内容之前；原位置的结果不重复输出。
   *
   * 确定性清理（仅 payload 层）：
   * - 反向孤儿 result（无对应 call）：删除，记 error
   * - 同 ID 重复 result：保留第一条，删除后续，记 error
   * - 唯一 call/result 位置错开：归位
   * - missing result：不在序列化阶段合成
   * - 未配对 tool_use：不删除（不假装成功——pending ask_user 必须存活）
   * - 重复 call ID：不猜测、不合并，照常发送交 Anthropic 报错
   */
  private normalizeToolMessagesForRequest(messages: Message[]): Message[] {
    const isToolUse = (block: unknown): block is { type: 'tool_use'; id: string } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'tool_use' &&
      typeof (block as { id?: unknown }).id === 'string';
    const isToolResult = (block: unknown): block is { type: 'tool_result'; tool_use_id: string } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'tool_result' &&
      typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string';

    // ── Pass 1: call ID 出现次数（重复 call ID 不可唯一匹配，不归位） ──
    const callCount = new Map<string, number>();
    for (const msg of messages) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (isToolUse(block)) {
          callCount.set(block.id, (callCount.get(block.id) ?? 0) + 1);
        }
      }
    }

    // ── Pass 2: 收集 result（保留第一条）；反向孤儿/重复条只记不进 map ──
    const resultById = new Map<string, unknown>();
    let orphanResultCount = 0;
    let duplicateResultCount = 0;
    for (const msg of messages) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (!isToolResult(block)) continue;
        const id = block.tool_use_id;
        if (!callCount.has(id)) {
          orphanResultCount += 1;
          continue;
        }
        if (resultById.has(id)) {
          duplicateResultCount += 1;
          continue;
        }
        resultById.set(id, block);
      }
    }
    if (orphanResultCount > 0 || duplicateResultCount > 0) {
      appLog.warn({
        event: 'agent.conversation.normalize.degraded',
        message: 'Invalid tool results were removed from the model request',
        context: {
          scope: 'agent.conversation',
          orphanResultCount,
          duplicateResultCount,
        },
      });
    }

    // ── Pass 3: 重建 payload ──
    const result: Message[] = [];
    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        // 不删除任何 tool_use：missing result 不合成，未配对 call 原样发送
        result.push(msg);
        // 可唯一匹配且有 result 的 call → 紧随批次集中输出，顺序与 call 顺序一致
        const batchResults: unknown[] = [];
        for (const block of msg.content) {
          if (isToolUse(block) && callCount.get(block.id) === 1) {
            const r = resultById.get(block.id);
            if (r) batchResults.push(r);
          }
        }
        if (batchResults.length > 0) {
          result.push({ role: 'user', content: batchResults as Message['content'] });
        }
        continue;
      }

      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const toolBlocks: unknown[] = [];
        const otherBlocks: unknown[] = [];
        for (const block of msg.content) {
          if (isToolResult(block)) {
            const id = block.tool_use_id;
            // 可唯一匹配的 result 已随批次归位，原位置不重复输出
            if (callCount.get(id) === 1) continue;
            // 反向孤儿 / 重复条（非 map 中保留的第一条）→ 删除（Pass 2 已记 error）
            if (resultById.get(id) !== block) continue;
            // 重复 call ID 的 result：不猜测、不合并，原位保留
            toolBlocks.push(block);
          } else {
            otherBlocks.push(block);
          }
        }
        // tool_result 块位于普通内容之前
        const remaining = [...toolBlocks, ...otherBlocks];
        if (remaining.length > 0) {
          result.push({ ...msg, content: remaining as Message['content'] });
        }
        continue;
      }

      result.push(msg);
    }

    return result;
  }

  getAllMessages(): Message[] {
    return this.stripRuntimeMessageFields(this.context.fullMessages);
  }

  /** Query the canonical ToolEntry.ok fact without leaking it into provider messages. */
  isToolCallSuccessful(toolUseId: string): boolean {
    return this.context.fullMessages.some((message) => {
      if (
        message.role !== 'user' ||
        message.toolResultOk !== true ||
        !Array.isArray(message.content)
      )
        return false;
      return message.content.some(
        (block) => block.type === 'tool_result' && block.tool_use_id === toolUseId
      );
    });
  }

  private recordMessage(
    message: Message,
    metadata: Pick<EnhancedMessage, 'toolResultOk'> &
      Partial<Pick<EnhancedMessage, 'id' | 'timestamp' | 'persisted'>> = {}
  ): EnhancedMessage {
    const enhanced = this.createMessageRecord(message, metadata);
    this.appendMessageRecord(enhanced);
    return enhanced;
  }

  private createMessageRecord(
    message: Message,
    metadata: Pick<EnhancedMessage, 'toolResultOk'> &
      Partial<Pick<EnhancedMessage, 'id' | 'timestamp' | 'persisted'>> = {}
  ): EnhancedMessage {
    return {
      ...message,
      id: generateMessageId(),
      timestamp: Date.now(),
      ...metadata,
    };
  }

  private appendMessageRecord(enhanced: EnhancedMessage): void {
    this.context.fullMessages.push(enhanced);
    this.appendedTokenUpperBound += messageTokenUpperBound(enhanced);
  }

  /** 捕获本次请求实际覆盖的最后一条消息；后续追加事实不会被误提交。 */
  captureRequestBoundary(): string | undefined {
    return this.context.fullMessages.at(-1)?.id;
  }

  /** 提交一次成功请求消费的边界，并用 provider 事实刷新上下文测量。 */
  commitSuccessfulRequest(boundaryMessageId: string | undefined, requestInfo: AIRequestInfo): void {
    if (boundaryMessageId !== undefined) {
      const boundaryIndex = this.context.fullMessages.findIndex(
        (message) => message.id === boundaryMessageId
      );
      if (boundaryIndex >= 0) {
        this.consumedThrough = Math.max(this.consumedThrough, boundaryIndex + 1);
      }
    }

    const inputTokens = requestInfo.usage.inputTokens;
    this.lastMeasurement =
      inputTokens === undefined ? undefined : { target: requestInfo.model, tokens: inputTokens };
    this.appendedTokenUpperBound = 0;
  }

  /**
   * 当前上下文占用。没有遍历、没有求和：`tokens` 要么是
   * provider 用当前模型量出来的数，要么是「还没量过」（界面显示「—」）。
   * 压缩判定与 UI 消费的是同一个返回值。
   */
  getContextUsage(): ContextUsage {
    const limit = this.getModelLimit();
    const m = this.lastMeasurement;
    if (m?.target !== formatModelTarget(this.target)) return { limit };
    return { tokens: m.tokens, limit, percentage: (m.tokens / limit) * 100 };
  }

  /**
   * 上下文明细。冷路径，按需拉取——整份系统提示词与全部消息正文不得进入
   * 每一条状态广播的 IPC 载荷。
   */
  buildContextSnapshot(systemPrompt: string, tools: readonly Tool[]): ContextSnapshot {
    const messages = this.projectModelMessages();
    return {
      systemPrompt,
      tools,
      messages,
      requestTokenCheckpoints: this.projectRequestTokenCheckpoints(messages),
      usage: this.getContextUsage(),
    };
  }

  projectRequestTokenCheckpoints(
    messages: readonly Message[]
  ): ContextRequestTokenCheckpoint[] {
    const assistantTokens = this.context.fullMessages
      .filter((message) => message.role === 'assistant')
      .map((message) => this.assistantInputTokens.get(message));
    let assistantIndex = 0;
    const checkpoints: ContextRequestTokenCheckpoint[] = [];
    messages.forEach((message, messageIndex) => {
      if (message.role !== 'assistant') return;
      const inputTokens = assistantTokens[assistantIndex++];
      if (inputTokens !== undefined) checkpoints.push({ messageIndex, inputTokens });
    });
    return checkpoints;
  }

  /** 完成请求准入和必要压缩后，返回本轮稳定的模型消息投影。 */
  async getMessagesForAI(
    request: CompactionRequestShape,
    signal?: AbortSignal,
    onCompactionActivity?: CompactionActivityCallback
  ): Promise<PreparedRequestMessages> {
    this.lastRequestShape = request;
    await this.admit(request, signal, onCompactionActivity);
    return { messages: this.projectModelMessages() };
  }

  /**
   * 向 provider 问这份 payload 的精确 token 数。
   *
   * 拿不到有两种原因——driver 无此能力（OpenAI 协议没有 count 端点）、或这次调用失败。
   * 两者的后续动作**完全相同**：把请求发出去让服务端判。所以这里合并成一个
   * `undefined`，而不是分成两条路——分开只会多一个没有人据以做不同事的分支。
   * 无论哪种，都不退回本地估算：本地没有分词器，算出来的只能是猜的。
   */
  private async countInputTokens(
    request: CompactionRequestShape,
    signal?: AbortSignal
  ): Promise<number | undefined> {
    try {
      return await this.inference.countInputTokens(
        { ...request, messages: this.projectModelMessages() },
        signal
      );
    } catch (error) {
      appLog.warn({
        event: 'agent.token_count.request.degraded',
        message: 'Provider token count was unavailable',
        context: {
          scope: 'agent.token_count',
          model: formatModelTarget(this.target),
        },
        error,
      });
      return undefined;
    }
  }

  /**
   * 请求前准入：两级，没有一级填本地猜的值。
   *
   * 一级——零成本：上一次 provider 的测量 + 本轮新增的严格上界仍在阈值内，直接发。
   * 二级——一级答不上来（尺子对不上 / 新增太大）时向 provider 要真值；
   * 它不肯提前说（无 count 端点）就发出去让服务端判，由溢出错误那条路兜底。
   */
  private async admit(
    request: CompactionRequestShape,
    signal?: AbortSignal,
    onCompactionActivity?: CompactionActivityCallback
  ): Promise<void> {
    if (this.isCompacting) return;

    const limit = this.getModelLimit();
    const overThreshold = (tokens: number) =>
      this.compactionEngine.shouldCompact((tokens / limit) * 100);

    const anchor = this.getContextUsage().tokens;
    if (anchor !== undefined) {
      if (!overThreshold(anchor + this.appendedTokenUpperBound)) return;
      // 锚点自己就过了阈值：再问 provider 也是同一个结论，省掉这次往返
      if (overThreshold(anchor)) {
        await this.performCompaction(anchor, limit, request, signal, onCompactionActivity);
        return;
      }
    }

    const measured = await this.countInputTokens(request, signal);
    if (measured === undefined) return;

    this.lastMeasurement = { target: formatModelTarget(this.target), tokens: measured };
    this.appendedTokenUpperBound = 0;
    if (overThreshold(measured)) {
      await this.performCompaction(measured, limit, request, signal, onCompactionActivity);
    }
  }

  /**
   * provider 判定超窗后的恢复：压缩历史并重建消息。
   *
   * 返回 `undefined` 表示压缩不成立（没有可压缩的历史）——此时原错误就是准确原因：
   * 单条新增内容自己就超过了窗口，而压缩删的是历史，不是新输入。
   */
  async compactAfterOverflow(
    signal?: AbortSignal,
    onCompactionActivity?: CompactionActivityCallback
  ): Promise<Message[] | undefined> {
    const request = this.lastRequestShape;
    if (!request) return undefined;
    const limit = this.getModelLimit();
    const compacted = await this.performCompaction(
      this.lastMeasurement?.tokens ?? limit,
      limit,
      request,
      signal,
      onCompactionActivity
    );
    return compacted ? this.projectModelMessages() : undefined;
  }

  private notifyCompactionActivity(
    callback: CompactionActivityCallback | undefined,
    active: boolean
  ): void {
    try {
      callback?.(active);
    } catch (error) {
      appLog.warn({
        event: 'agent.compaction_activity.publish.degraded',
        message: 'Compaction activity publication degraded',
        context: { scope: 'agent.compaction_activity', active },
        error,
      });
    }
  }

  /**
   * 用单一摘要替换 processed 前缀，pending 后缀保持原始内容与顺序。
   * @param signal 冲程取消域：摘要 AI 请求随冲程 abort 协作退出
   */
  private async performCompaction(
    currentTokens: number,
    modelLimit: number,
    request: CompactionRequestShape,
    signal?: AbortSignal,
    onCompactionActivity?: CompactionActivityCallback
  ): Promise<boolean> {
    if (this.isCompacting) return false;

    this.isCompacting = true;
    this.notifyCompactionActivity(onCompactionActivity, true);

    try {
      appLog.info({
        event: 'agent.compaction.run.started',
        message: 'Context compaction started',
        context: {
          scope: 'agent.compaction',
          modelTokenLimit: modelLimit,
          currentTokenCount: currentTokens,
          messageCount: this.context.fullMessages.length,
        },
      });

      // 压缩会替换 fullMessages，先把未持久化的内容落盘
      this.flush();

      // processed 全部由摘要替代；pending 不进入摘要也不改写。
      const processedMessages = this.context.fullMessages.slice(0, this.consumedThrough);
      const pendingMessages = this.context.fullMessages.slice(this.consumedThrough);
      if (processedMessages.length === 0) return false;
      if (this.toolProtocolCrossesBoundary(processedMessages, pendingMessages)) {
        appLog.error({
          event: 'agent.compaction.validate.rejected',
          message: 'Context compaction rejected an invalid boundary',
          context: { scope: 'agent.compaction', reason: 'tool_protocol_split' },
        });
        return false;
      }

      const history = this.projectModelMessages(processedMessages);

      const result = await this.compactionEngine.compact(
        history,
        processedMessages.length,
        currentTokens,
        request,
        signal
      );

      if (result.success && result.summary) {
        try {
          result.summary.originalMessagesFile = await compactionArchive.archiveOriginalMessages(
            this.mainAgentId,
            result.summary.id,
            processedMessages
          );
        } catch (error) {
          appLog.warn({
            event: 'agent.compaction_archive.persist.degraded',
            message: 'Compaction archive persistence degraded',
            context: { scope: 'agent.compaction_archive', archiveKind: 'messages' },
            error,
          });
        }

        const compactionTimestamp = Date.now();

        // 新摘要已看到上一代摘要和完整 processed 前缀；提交后只留下 pending。
        this.context.summaries = [result.summary];
        this.context.fullMessages = pendingMessages;
        this.consumedThrough = 0;

        // 锚点量的是压缩前那份上下文，现在它不存在了。作废 ⇒ 下一轮强制走二级准入
        // 复核；不作废的话锚点会持续偏高，把后面每一轮都误判成需要再压一次。
        this.lastMeasurement = undefined;

        // 持久化摘要条目：replay 时从最后一个 summary 开始重建
        this.persistEntry({
          t: 'summary',
          ts: compactionTimestamp,
          summary: result.summary,
        });

        appLog.info({
          event: 'agent.compaction.run.completed',
          message: 'Context compaction completed',
          context: {
            scope: 'agent.compaction',
            compressedMessageCount: result.compressedCount,
            remainingMessageCount: this.context.fullMessages.length,
            summaryCount: this.context.summaries.length,
          },
        });
      } else {
        appLog.warn({
          event: 'agent.compaction.run.degraded',
          message: 'Context compaction degraded',
          context: { scope: 'agent.compaction', reason: result.reason },
        });
        return false;
      }
    } catch (error) {
      appLog.warn({
        event: 'agent.compaction.run.degraded',
        message: 'Context compaction degraded',
        context: { scope: 'agent.compaction' },
        error,
      });
      return false;
    } finally {
      this.isCompacting = false;
      this.notifyCompactionActivity(onCompactionActivity, false);
    }

    return true;
  }

  /** 摘要与后续事实保持独立消息，provider 协议适配不在这里发生。 */
  private projectModelMessages(
    source: EnhancedMessage[] = this.context.fullMessages
  ): Message[] {
    const messages = this.projectMessages(source);
    const latestSummary = this.context.summaries[this.context.summaries.length - 1];
    if (!latestSummary) return messages;
    return [
      {
        role: 'user',
        content: latestSummary.markdown,
        subtype: 'context_summary',
      },
      ...messages,
    ];
  }

  private toolProtocolCrossesBoundary(
    processed: EnhancedMessage[],
    pending: EnhancedMessage[]
  ): boolean {
    const ids = (messages: EnhancedMessage[]) => {
      const calls = new Set<string>();
      const results = new Set<string>();
      for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (block.type === 'tool_use' && block.id) calls.add(block.id);
          if (block.type === 'tool_result' && block.tool_use_id) results.add(block.tool_use_id);
        }
      }
      return { calls, results };
    };
    const left = ids(processed);
    const right = ids(pending);
    return (
      [...left.calls].some((id) => right.results.has(id)) ||
      [...right.calls].some((id) => left.results.has(id))
    );
  }

  private stripRuntimeMessageFields(source: EnhancedMessage[]): Message[] {
    const projected: Message[] = [];
    for (const message of source) {
      const { role, content, subtype } = message;
      projected.push({ role, content, subtype });
    }
    return projected;
  }

  /** Resume 只恢复最后一个摘要，后续消息继续按 JSONL 顺序重放。 */
  restoreSummary(summary: ContextSummary): void {
    this.context = {
      summaries: [summary],
      fullMessages: [],
    };
    this.consumedThrough = 0;
  }

  /** 模型上下文窗口（token）。恒有值，下限钳制在 inference port 内。 */
  private getModelLimit(): number {
    return this.inference.contextWindow(this.target);
  }

  /**
   * 切换模型。
   *
   * 换模型就是换尺子：旧读数立即作废，**不按倍率折算**——同族模型间实测倍率
   * 可达 1.67×，折算出来的就是估算。作废之后立刻向新模型重算一次，
   * 因为切模型的动机常常正是上下文太长，那恰恰是最需要看到这个数的时刻。
   */
  setTarget(target: ModelTarget): void {
    const staleMeasurement = this.lastMeasurement;
    this.target = target;
    this.lastMeasurement = undefined;

    const shape = this.lastRequestShape;
    // 没有可作废的测量就不发这次请求：新建 agent 的 setModel 走这条，上下文本来就是空的
    if (!staleMeasurement || !shape) return;
    const nextShape = { ...shape, model: target };
    this.lastRequestShape = nextShape;
    void this.remeasure(nextShape);
  }

  /** 切模型后的立即重算。失败或无此能力 ⇒ 测量保持为空（界面「—」），不猜。 */
  private async remeasure(request: CompactionRequestShape): Promise<void> {
    const measuredFor = formatModelTarget(this.target);
    const tokens = await this.countInputTokens(request);
    // 期间可能又切了一次模型；晚到的读数不能覆盖新尺子
    if (tokens === undefined || formatModelTarget(this.target) !== measuredFor) return;
    this.lastMeasurement = { target: measuredFor, tokens };
    this.appendedTokenUpperBound = 0;
    this.measurementHook?.();
  }
}
