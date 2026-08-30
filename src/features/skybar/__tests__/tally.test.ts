import { describe, expect, it } from 'vitest';
import { absorbTargets, createTokenTally } from '../tally';
import type { AgentControlTarget } from '../../../domains/agent-control/agent-control-store';

function target(tokens: { input: number; output: number }): AgentControlTarget {
  return {
    kind: 'agent',
    mainAgentId: 'a',
    state: {
      runMetrics: { inputTokens: tokens.input, outputTokens: tokens.output },
    },
  } as unknown as AgentControlTarget;
}

describe('skybar token tally(纯加法汇总)', () => {
  it('吸收读数增量并单调累计', () => {
    const tally = createTokenTally();
    expect(absorbTargets(tally, { a: target({ input: 100, output: 40 }) })).toBe(140);
    expect(absorbTargets(tally, { a: target({ input: 160, output: 90 }) })).toBe(250);
  });

  it('幂等:同一快照重复吸收增量为零', () => {
    const tally = createTokenTally();
    const frame = { a: target({ input: 100, output: 40 }) };
    absorbTargets(tally, frame);
    expect(absorbTargets(tally, frame)).toBe(140);
  });

  it('目标离场不回落', () => {
    const tally = createTokenTally();
    absorbTargets(tally, {
      a: target({ input: 100, output: 0 }),
      b: target({ input: 50, output: 0 }),
    });
    expect(absorbTargets(tally, { a: target({ input: 120, output: 0 }) })).toBe(170);
  });

  it('会话恢复后从零重计:只重置基线,不做减法,不重复计', () => {
    const tally = createTokenTally();
    absorbTargets(tally, { a: target({ input: 200, output: 0 }) });
    // 恢复后 runMetrics 归零重新起算
    expect(absorbTargets(tally, { a: target({ input: 0, output: 0 }) })).toBe(200);
    expect(absorbTargets(tally, { a: target({ input: 30, output: 10 }) })).toBe(240);
  });

  it('主代理与子代理各按目标独立记账', () => {
    const tally = createTokenTally();
    absorbTargets(tally, {
      main: target({ input: 10, output: 5 }),
      'worker-1': target({ input: 20, output: 8 }),
    });
    expect(tally.total).toBe(43);
    // 子代理退出,主代理继续涨
    expect(absorbTargets(tally, { main: target({ input: 15, output: 9 }) })).toBe(52);
  });
});
