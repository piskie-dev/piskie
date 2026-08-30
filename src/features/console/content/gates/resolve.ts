/**
 * 门种类决策——**唯一**决策点，纯函数、零 React（因此可直接单测）。
 *
 * 决策在这里一次做完，互斥由返回值的判别联合保证——拆成几段 JSX 条件的话，互斥性就得靠
 * 书写顺序维持（漏一个 `&& !state.pendingToolCall` 就会两个门同时叠在底部）。
 *
 * 优先级：
 * 1. `pendingToolCall` 一律压过提问
 * 2. 带 `preview` 的按类型分流：diff 走 diff 门；command/text（shell 命令、
 *    edit 的失败说明）走命令门——内容直接铺在门里，批准要跑什么必须一眼可见
 * 3. `plan` + `action === 'create'` 走计划门
 * 4. 其余走工具门
 *
 * 「只有主 agent 才出提问门」由类型承载——`WorkerVM` 没有 `askUser` 字段，
 * worker 面板结构上传不进来。
 */

import type { AIQuestionItem, PendingToolCall } from '../../../../../shared/types';
import type { GateRequest } from './contract';

/** 门的输入面：`AgentVM` / `WorkerVM` 都能直接塞进来 */
export interface GateSource {
  readonly pendingToolCall?: PendingToolCall;
  readonly askUser?: { readonly id: string; readonly items: readonly AIQuestionItem[] };
}

function readParam(call: PendingToolCall, key: string): unknown {
  return (call.params as Record<string, unknown> | undefined)?.[key];
}

export function resolveGateRequest(source: GateSource): GateRequest | null {
  const call = source.pendingToolCall;

  if (call) {
    if (call.preview) {
      return call.preview.type === 'diff' ? { kind: 'diff', call } : { kind: 'command', call };
    }

    if (call.toolName === 'plan' && readParam(call, 'action') === 'create') {
      const taskSummary = readParam(call, 'taskSummary');
      return { kind: 'plan', call, taskSummary: typeof taskSummary === 'string' ? taskSummary : '' };
    }

    return { kind: 'tool', call };
  }

  const askUser = source.askUser;
  if (askUser && askUser.items.length > 0) {
    return { kind: 'question', id: askUser.id, items: askUser.items };
  }

  return null;
}
