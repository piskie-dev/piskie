/**
 * isBusy/canPause 对 pendingQuestion 的派生行为：
 * pending ask 稳态（waiting + 无 timer）必须 canPause=true，否则 ESC 按钮不可达。
 */
import { describe, it, expect } from 'vitest';
import { canPause } from '../agent-control';

type PausableArg = Parameters<typeof canPause>[0];

const base = { agentId: 'a' } as unknown as PausableArg;

describe('canPause 与派生 pendingQuestion（可达性）', () => {
  it('waiting + pendingQuestion → 可中断（ESC 按钮可达）', () => {
    expect(canPause({ ...base, phase: 'waiting', pendingQuestion: { id: 'ask-1' } })).toBe(true);
  });

  it('waiting + 无 pendingQuestion → 不可中断', () => {
    expect(canPause({ ...base, phase: 'waiting' })).toBe(false);
  });

  it('stopping 恒不可中断；子代理 pendingQuestion 也计入', () => {
    expect(canPause({ ...base, phase: 'stopping', pendingQuestion: { id: 'x' } })).toBe(false);
    expect(canPause({
      ...base,
      phase: 'waiting',
      children: [{ ...base, phase: 'waiting', pendingQuestion: { id: 'child-ask' } }],
    } as never)).toBe(true);
  });
});
