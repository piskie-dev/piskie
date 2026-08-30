/**
 * AgentMailbox — Agent 事件唯一真相源（Mailbox + Pump 单链路执行模型）
 *
 * 纯数据结构：没有 waiter、没有 Deferred、没有回调——它不知道 Runtime 的存在。
 * 保存事实（Mailbox）与调度消费（ensurePump）在 runtime.post() 一处顺序完成。
 * 消费必须经 AgentEngine.takeEvents()（drain + 单点 batch trace 同一同步块），
 * 禁止在其他位置裸调 drain()。
 */

import type { AgentInputEvent, AgentInputRequest } from '../../shared/types/index.js';
import { createUuid } from '@shared/utils/identifiers.js';

export class AgentMailbox {
  private queue: AgentInputEvent[] = [];

  /** 纯入队，不做任何调度 */
  push(event: AgentInputEvent): void {
    this.queue.push(event);
  }

  /** 取走全部事件；每个事件最多被 drain 一次。 */
  drain(): AgentInputEvent[] {
    const events = this.queue;
    this.queue = [];
    return events;
  }

  /** 当前 FIFO 队列的非消费快照；调用方不能借此替换 Mailbox 存储。 */
  snapshot(): readonly AgentInputEvent[] {
    return [...this.queue];
  }

  hasEvents(): boolean {
    return this.queue.length > 0;
  }

  get size(): number {
    return this.queue.length;
  }
}

/**
 * envelope 归一化 — post() 唯一入口的全函数构造：
 * 补全 id/timestamp，永不因内容拒绝。timestamp 容忍 IPC 序列化产物（ISO 字符串）。
 * 业务载荷校验在生产边界（工具 schema / IPC parse），不在此处。
 */
export function normalizeAgentInputEvent(input: AgentInputRequest): AgentInputEvent {
  const ts = input.timestamp;
  return {
    ...input,
    id: input.id || createUuid(),
    timestamp: ts instanceof Date ? ts : ts ? new Date(ts as unknown as string | number) : new Date(),
  };
}

// ─── 执行模型错误类型（三出口） ─────────────

/** 用户中断（interrupt 的 abort reason）：出口分类为 cancelled，不是失败 */
export class UserInterruptError extends Error {
  constructor(reason?: string) {
    super(reason || 'user interrupted');
    this.name = 'UserInterruptError';
  }
}

/** runtime 拆除（destroy 的 abort reason）：出口分类为 cancelled */
export class DisposedError extends Error {
  constructor() {
    super('runtime disposed');
    this.name = 'DisposedError';
  }
}

/** 事件批次应用失败：携带本批 event ids，让 AgentIncident 与父通知自包含 */
export class EventBatchApplyError extends Error {
  readonly eventIds: string[];

  constructor(eventIds: string[], cause: unknown) {
    super(`事件批次应用失败（${eventIds.length} 个事件: ${eventIds.join(', ')}）`, { cause });
    this.name = 'EventBatchApplyError';
    this.eventIds = eventIds;
  }
}
