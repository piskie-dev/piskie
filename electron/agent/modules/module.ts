/**
 * AgentModule — 可组合能力模块接口
 * 替代 AgentPlugin，通过 AgentHost 类型安全交互（不再 as any）。
 */

import type { AgentHost } from '../agent-host.js';
import type { ToolContextBuilder } from '../tool-context.js';
import type { AgentInputEvent } from '../../../shared/types/index.js';

export interface AgentModule {
  readonly name: string;

  /** 初始化（host 替代 agent as any） */
  init(host: AgentHost, config: Record<string, unknown>): void;

  /** 首次启动 */
  onStart?(): Promise<void>;

  /**
   * 中断处理（钩子三时刻之一）：activation 级，清排队任务；
   * interrupt 与 destroy 同步前缀共用；不动任何边界、不碰租约。
   */
  onInterrupt?(): void;

  /**
   * 发起己方拥有边界的最终关闭（按边界所有权表）：
   * 仅 destroy 同步前缀调用；发起即返回，closePromise 交 destroy 原语
   * 当场 allSettled 消费；不碰租约（释放唯一写入点是 releaseResources）。
   */
  onDestroyBegin?(): Promise<void> | void;

  /**
   * 剩余重清理（模块内存级），finishDestroy join 后调用；
   * 不重复汇总同一 closePromise；非关键错误内部降级自吞（rejection 语义收紧，
   * destroy rejection 只表示 teardown 不变量未建立）；不碰租约。
   */
  onDestroy?(): Promise<void>;

  /** 工具上下文贡献（类型化，替代 metadata 袋子） */
  contributeTools?(builder: ToolContextBuilder): void;

  /** 事件处理：返回 true = 已消费 */
  processEvent?(event: AgentInputEvent): boolean;

  /** 子 Agent 列表（级联中断用） */
  listChildAgents?(): AgentEngine[];
}

// AgentEngine 前向声明（避免循环依赖）
// 实际类型在 agent-engine.ts 中定义
export type AgentEngine = import('../agent-engine.js').AgentEngine;
