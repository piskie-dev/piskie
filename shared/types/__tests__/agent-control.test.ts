/**
 * 产品出口谓词单测：出口谓词只有一个定义来源。
 */

import { describe, expect, it } from 'vitest';
import {
  canStop,
  canPause,
  collectInterruptedTargets,
  isInterrupted,
  type AgentPhase,
} from '../agent-control.js';

const ALL_PHASES: AgentPhase[] = ['thinking', 'executing', 'waiting', 'stopping'];

describe('产品出口谓词', () => {
  it('canStop 对活跃会话恒真——stopping 不例外', () => {
    for (const phase of ALL_PHASES) {
      expect(canStop({ phase })).toBe(true);
    }
  });

  it('canPause 覆盖自身运行与待回答问题', () => {
    expect(canPause({ phase: 'thinking' })).toBe(true);
    expect(canPause({ phase: 'executing' })).toBe(true);
    expect(canPause({ phase: 'waiting' })).toBe(false);
    expect(canPause({ phase: 'waiting', pendingQuestion: { id: 'ask-1' } })).toBe(true);
    expect(canPause({ phase: 'stopping' })).toBe(false);
  });

  it('canPause 是树级谓词，且主 stopping 时不重复发起', () => {
    expect(canPause({
      phase: 'waiting',
      children: [{ phase: 'executing' }],
    })).toBe(true);
    expect(canPause({
      phase: 'waiting',
      children: [{ phase: 'waiting', pendingQuestion: { id: 'ask-1' } }],
    })).toBe(true);
    expect(canPause({
      phase: 'waiting',
      children: [{ phase: 'waiting' }],
    })).toBe(false);
    expect(canPause({
      phase: 'stopping',
      children: [{ phase: 'executing' }],
    })).toBe(false);
  });

  it('isInterrupted 只认显式 true', () => {
    expect(isInterrupted({ interrupted: true })).toBe(true);
    expect(isInterrupted({ interrupted: false })).toBe(false);
    expect(isInterrupted({})).toBe(false);
  });

  it('collectInterruptedTargets 对整树级联去重', () => {
    expect(collectInterruptedTargets([{
      agentId: 'main-1',
      interrupted: true,
      children: [{ id: 'child-1', interrupted: true }],
    }])).toEqual([{ kind: 'main', id: 'main-1' }]);

    expect(collectInterruptedTargets([{
      agentId: 'main-2',
      children: [
        { id: 'child-2', interrupted: true },
        { id: 'child-3', interrupted: false },
      ],
    }])).toEqual([{ kind: 'child', id: 'child-2' }]);
  });
});
