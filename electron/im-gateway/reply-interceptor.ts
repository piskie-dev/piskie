import { appLog } from '@electron/observability/logging/app-log.js';
import type { IMReplyForwardConfig } from '@shared/types/im-gateway.js';
import { DEFAULT_REPLY_FORWARD_CONFIG } from './reply-forward-policy.js';
import type { DispatchYieldOutcome, ReplyDispatcher } from './core/channel-connector.js';
import type { AgentContentEvent } from '../tools/types.js';

export type { DispatchYieldOutcome } from './core/channel-connector.js';

/** 只属于一次 waitForNextYield() 调用的短生命周期运输状态，不携带 Bot/Agent 世代身份 */
interface DispatchYieldWaiter {
  resolve: (outcome: DispatchYieldOutcome) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** 该 Agent 当前回复发往哪个出口的长生命周期运输绑定（唯一运输绑定表的值） */
interface ReplyBinding {
  /** 当前 dispatcher 来自哪个 Bot——仅供 stopBot 扫描清理，不参与 Agent 解析 */
  ownerBotId: string;
  dispatcher: ReplyDispatcher;
  config: IMReplyForwardConfig;
  yieldWaiters: Set<DispatchYieldWaiter>;
}

/**
 * Intercepts Agent output observations and forwards content via ReplyDispatcher.
 *
 * 唯一运输绑定表：agentId → ReplyBinding。
 * turn_end 只清 waiter 不清 binding（没有新入站消息时后续 Pump 输出继续走保留的
 * 最新 dispatcher）；binding 只在 Agent stop/state-null 或 Bot stop 时删除。
 */
export class ReplyInterceptor {
  private readonly bindings = new Map<string, ReplyBinding>();

  /**
   * 注册/更新某 Agent 的当前出站 dispatcher（用户事件注入前调用）。
   * 已有 binding 时原位更新 ownerBotId/dispatcher/config 并复用同一 yieldWaiters Set；
   * 未传配置写入默认配置（不能沿用旧配置）。latest-message-wins。
   */
  setDispatcher(
    agentId: string,
    ownerBotId: string,
    dispatcher: ReplyDispatcher,
    replyForwardConfig?: IMReplyForwardConfig
  ): void {
    const existing = this.bindings.get(agentId);
    if (existing) {
      if (existing.dispatcher !== dispatcher) {
        this.closeOpenTools(existing.dispatcher, agentId);
      }
      existing.ownerBotId = ownerBotId;
      existing.dispatcher = dispatcher;
      existing.config = replyForwardConfig ?? DEFAULT_REPLY_FORWARD_CONFIG;
      return;
    }
    this.bindings.set(agentId, {
      ownerBotId,
      dispatcher,
      config: replyForwardConfig ?? DEFAULT_REPLY_FORWARD_CONFIG,
      yieldWaiters: new Set(),
    });
  }

  /**
   * 等待该 Agent 下一次 Pump yield（turn_end）。每次调用创建独立 waiter 加入 Set；
   * binding 已不存在时立即返回 binding_removed。timeout 只按对象身份释放自身。
   */
  waitForNextYield(agentId: string, timeoutMs = 300_000): Promise<DispatchYieldOutcome> {
    const binding = this.bindings.get(agentId);
    if (!binding) return Promise.resolve('binding_removed');

    return new Promise((resolve) => {
      const waiter: DispatchYieldWaiter = {
        resolve,
        timeout: setTimeout(() => this.settleYieldWaiter(binding, waiter, 'timeout'), timeoutMs),
      };
      binding.yieldWaiters.add(waiter);
    });
  }

  /** 按对象身份结算单个 waiter：不在 Set 中（已被结算）则 no-op */
  private settleYieldWaiter(
    binding: ReplyBinding,
    waiter: DispatchYieldWaiter,
    outcome: DispatchYieldOutcome
  ): void {
    if (!binding.yieldWaiters.delete(waiter)) return;
    clearTimeout(waiter.timeout);
    waiter.resolve(outcome);
  }

  /** 删除 binding：清 timer 并以 binding_removed 释放全部 waiter，让运输调用正常收尾 */
  removeBinding(agentId: string): void {
    const binding = this.bindings.get(agentId);
    if (!binding) return;
    this.closeOpenTools(binding.dispatcher, agentId);
    this.bindings.delete(agentId);
    for (const waiter of [...binding.yieldWaiters]) {
      this.settleYieldWaiter(binding, waiter, 'binding_removed');
    }
  }

  /**
   * 对象身份 CAS 删除：仅当 binding 仍存在、ownerBotId 相同且
   * dispatcher === expectedDispatcher 时删除。供 inject false/抛错清理由本次
   * dispatch 安装且仍未被替换的陈旧 binding；不满足时 no-op（不能删除后来消息的新出口）。
   */
  removeBindingIfCurrent(
    agentId: string,
    ownerBotId: string,
    expectedDispatcher: ReplyDispatcher
  ): boolean {
    const binding = this.bindings.get(agentId);
    if (
      !binding ||
      binding.ownerBotId !== ownerBotId ||
      binding.dispatcher !== expectedDispatcher
    ) {
      return false;
    }
    this.removeBinding(agentId);
    return true;
  }

  /**
   * 对象身份 CAS 原位替换 dispatcher（飞书 queue 收尾后的 lateSink 切换专用，同步）。
   * binding 已删除或 dispatcher 已被新消息替换时返回 false；绝不创建 binding。
   */
  replaceDispatcherIfCurrent(
    agentId: string,
    ownerBotId: string,
    expectedDispatcher: ReplyDispatcher,
    nextDispatcher: ReplyDispatcher,
    config?: IMReplyForwardConfig
  ): boolean {
    const binding = this.bindings.get(agentId);
    if (
      !binding ||
      binding.ownerBotId !== ownerBotId ||
      binding.dispatcher !== expectedDispatcher
    ) {
      return false;
    }
    if (binding.dispatcher !== nextDispatcher) {
      this.closeOpenTools(binding.dispatcher, agentId);
    }
    binding.dispatcher = nextDispatcher;
    binding.config = config ?? DEFAULT_REPLY_FORWARD_CONFIG;
    return true;
  }

  /** Bot 停止路径：按 ownerBotId 扫描唯一 bindings 表并释放该 Bot 的全部运输引用（幂等） */
  removeBindingsByOwner(ownerBotId: string): void {
    for (const [agentId, binding] of [...this.bindings]) {
      if (binding.ownerBotId === ownerBotId) {
        this.removeBinding(agentId);
      }
    }
  }

  /** Format tool params as code block (max 300 chars) */
  private renderForwardedToolArguments(params?: Record<string, unknown>): string {
    if (!params || Object.keys(params).length === 0) return '';
    const lines = Object.entries(params).map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${val}`;
    });
    let text = lines.join('\n');
    if (text.length > 300) text = text.substring(0, 300) + '...';
    return '\n```\n' + text + '\n```';
  }

  /** Check if a tool passes the filter */
  private shouldForwardTool(toolName: string, config: IMReplyForwardConfig): boolean {
    const { toolFilter } = config;
    if (!toolFilter) return true;
    const isInList = toolFilter.tools.includes(toolName);
    return toolFilter.mode === 'include' ? isInList : !isInList;
  }

  private closeOpenTools(dispatcher: ReplyDispatcher, agentId: string): void {
    try {
      dispatcher.toolProgress?.closeOpen('blocked');
    } catch (error) {
      appLog.warn({
        event: 'messaging.tool_progress.close.degraded',
        message: 'Messaging tool progress closure degraded',
        context: { scope: 'messaging.tool_progress', agentId: agentId },
        error,
      });
    }
  }

  /**
   * Process an Agent output observation.
   * Routes content to the current ReplyDispatcher; turn_end 释放全部 yield waiter。
   */
  processStateEvent(agentId: string, event: AgentContentEvent): void {
    const binding = this.bindings.get(agentId);
    if (!binding) {
      return;
    }
    const { dispatcher, config } = binding;

    switch (event.type) {
      case 'assistant_text':
        if (config.forwardAssistantText && event.content) {
          dispatcher.sendBlockReply({ text: event.content });
        }
        break;

      case 'tool_start':
        if (
          config.forwardToolCalls &&
          event.toolName &&
          this.shouldForwardTool(event.toolName, config)
        ) {
          if (event.toolName === 'ask_user') {
            dispatcher.sendToolResult({
              text: `🔧 ${event.toolName}${this.renderForwardedToolArguments(event.params)}`,
            });
          } else if (dispatcher.toolProgress && event.toolCallId) {
            dispatcher.toolProgress.start({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
          } else {
            if (dispatcher.toolProgress && !event.toolCallId) {
              appLog.warn({
                event: 'messaging.tool_progress.start.rejected',
                message: 'Messaging tool progress start rejected',
                context: {
                  scope: 'messaging.tool_progress',
                  agentId: agentId,
                  toolName: event.toolName,
                  reason: 'tool_call_id_missing',
                },
              });
            }
            dispatcher.sendToolResult({
              text: `🔧 ${event.toolName}${this.renderForwardedToolArguments(event.params)}`,
            });
          }
        }
        break;

      case 'tool_finish':
        if (
          event.toolName &&
          event.toolName !== 'ask_user' &&
          event.toolCallId &&
          this.shouldForwardTool(event.toolName, config)
        ) {
          dispatcher.toolProgress?.complete({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: event.ok ? 'completed' : 'failed',
          });
        }
        if (
          event.ok &&
          config.forwardToolResults &&
          event.toolName &&
          this.shouldForwardTool(event.toolName, config)
        ) {
          const result = event.result || '';
          const text = result.length > 500 ? result.substring(0, 500) + '...' : result;
          dispatcher.sendToolResult({
            text: `✅ ${event.toolName} 返回:\n\`\`\`\n${text}\n\`\`\``,
          });
        }
        break;

      case 'turn_end':
        this.handleTurnEnd(agentId);
        break;
    }
  }

  /**
   * turn_end 先发送空 sendFinalReply 作为结束标记，
   * 再释放该 agentId 当时累计的全部 waiter；不删除 ReplyBinding。
   */
  private handleTurnEnd(agentId: string): void {
    const binding = this.bindings.get(agentId);
    if (!binding) return;

    this.closeOpenTools(binding.dispatcher, agentId);

    binding.dispatcher.sendFinalReply({ text: '' });
    for (const waiter of [...binding.yieldWaiters]) {
      this.settleYieldWaiter(binding, waiter, 'yield');
    }
  }
}
