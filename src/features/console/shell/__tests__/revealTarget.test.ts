/**
 * 顶栏徽标 reveal 的目标解析（worker 级）。
 *
 * 判定逻辑在 `shell/revealTarget.ts`（纯函数，与 route state 消费分开，故无需 jsdom）。
 *
 * 固定三条：
 * 1. 主 agent 自己待确认/待回答 ⇒ **只给 agentId**（不误跳到某个 worker）
 * 2. 只有 worker 待确认 ⇒ 连带给出 workerId
 * 3. typed target 只在对应 Agent/Worker 当前仍存在时有效
 *
 * 第 1 条是有意的优先序：主 agent 的 `pendingQuestion` 阻塞整条会话，
 * 比某个 worker 的工具审批更急（见 `useHeaderAction` 文件头）。
 */

import { describe, expect, it } from 'vitest';

import type { AgentControlState, ChildControlState } from '../../../../../shared/types/agent-control';
import { firstAwaiting, isCurrentTarget } from '../revealTarget';

function child(over: Partial<ChildControlState> & { id: string }): ChildControlState {
  return {
    phase: 'executing',
    subject: over.id,
    mode: 'browser',
    ...over,
  } as ChildControlState;
}

function agent(over: Partial<AgentControlState> & { agentId: string }): AgentControlState {
  return {
    phase: 'executing',
    children: [],
    ...over,
  } as AgentControlState;
}

/** 解析器只判断"有没有"，不读字段；给一份最小合法值即可（不用 as unknown 绕类型） */
const pendingCall: NonNullable<AgentControlState['pendingToolCall']> = {
  id: 'call-1',
  agentId: 'a',
  mainAgentId: 'a',
  toolName: 'read',
  params: {},
  timestamp: new Date(0),
  description: '读取文件',
  category: 'document',
};

function states(...list: AgentControlState[]): Record<string, AgentControlState> {
  return Object.fromEntries(list.map((item) => [item.agentId, item]));
}

describe('firstAwaiting', () => {
  it('无待确认时返回 null', () => {
    expect(firstAwaiting(states(agent({ agentId: 'a' })))).toBeNull();
  });

  it('主 agent 自己待确认 ⇒ 不带 workerId', () => {
    const target = firstAwaiting(
      states(
        agent({
          agentId: 'a',
          pendingToolCall: pendingCall,
          children: [child({ id: 'w1', pendingToolCall: pendingCall })],
        }),
      ),
    );
    expect(target).toEqual({ agentId: 'a' });
  });

  it('只有 worker 待确认 ⇒ 连带 workerId', () => {
    const target = firstAwaiting(
      states(agent({ agentId: 'a', children: [child({ id: 'w1' }), child({ id: 'w2', pendingToolCall: pendingCall })] })),
    );
    expect(target).toEqual({ agentId: 'a', workerId: 'w2' });
  });
});

describe('isCurrentTarget', () => {
  const snapshot = states(agent({ agentId: 'a', children: [child({ id: 'w1' })] }));

  it('accepts a live top-level Agent target', () => {
    expect(isCurrentTarget({ agentId: 'a' }, snapshot)).toBe(true);
  });

  it('accepts a live Worker target', () => {
    expect(isCurrentTarget({ agentId: 'a', workerId: 'w1' }, snapshot)).toBe(true);
  });

  it('rejects targets removed before route consumption', () => {
    expect(isCurrentTarget({ agentId: 'missing' }, snapshot)).toBe(false);
    expect(isCurrentTarget({ agentId: 'a', workerId: 'missing' }, snapshot)).toBe(false);
  });
});
