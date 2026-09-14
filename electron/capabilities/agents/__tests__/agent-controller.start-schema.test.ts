import { describe, expect, it } from 'vitest';

import { AGENT_OPERATIONS } from '../../../../shared/electron-contracts/agents.js';
import { createAgentController } from '../agent-controller.js';

const startOperation = createAgentController({} as never, {} as never, () => []).operations
  .find(({ id }) => id === AGENT_OPERATIONS.start);

if (!startOperation) throw new Error('agents.start operation missing');

describe('agents.start public schema', () => {
  it.each(['/workspace/sample.txt', 'C:\\Sample Files\\sample.zip', '\\\\sample-server\\share\\sample.csv'])(
    'accepts structured file input at every user submission boundary: %s', (path) => {
      const files = [{ name: 'sample attachment', path }];
      const cases = [
        [AGENT_OPERATIONS.start, [{ input: '', modeId: 'normal', launchOptions: { files } }]],
        [AGENT_OPERATIONS.inject, ['sample-main', { source: 'user', content: '', files }]],
        [AGENT_OPERATIONS.injectSubagent, ['sample-main', 'sample-worker', { source: 'user', content: '', files }]],
        [AGENT_OPERATIONS.respondToApproval, ['sample-main', 'sample-worker', { callId: 'sample-call', decision: 'deny', feedback: '', files }]],
        [AGENT_OPERATIONS.regenerateImages, [{ agentId: 'sample-main', nodeId: 'sample-node', imageIds: ['sample-image'], instruction: '', files }]],
      ] as const;
      const operations = createAgentController({} as never, {} as never, () => []).operations;
      for (const [id, input] of cases) {
        const operation = operations.find((item) => item.id === id)!;
        expect(operation.input.parse(input)).toEqual(input);
        const invalid = JSON.parse(JSON.stringify(input).replace('"name":"sample attachment"', '"name":"sample attachment","extra":"sample"'));
        expect(operation.input.safeParse(invalid).success).toBe(false);
      }
    },
  );

  it('selects exactly one launch shape by definitionId or input', () => {
    expect(startOperation.input.safeParse([{ definitionId: 'td-AAAAAA' }]).success).toBe(true);
    expect(startOperation.input.safeParse([{ input: 'One-off task', modeId: 'normal' }]).success)
      .toBe(true);
    expect(startOperation.input.safeParse([{
      definitionId: 'td-AAAAAA',
      input: 'ambiguous',
      modeId: 'normal',
    }]).success).toBe(false);
  });

  it('accepts skills-only input, normalizes selections, and keeps definition launches separate', () => {
    const parsed = startOperation.input.parse([{
      input: '', modeId: 'normal', skills: ['sample-guide', ' other-guide ', 'sample-guide'],
    }]);
    expect(parsed).toEqual([{
      input: '', modeId: 'normal', skills: ['sample-guide', 'other-guide'],
    }]);
    for (const skills of ['sample-guide', [''], ['  '], [42]]) {
      expect(startOperation.input.safeParse([{ input: '', modeId: 'normal', skills }]).success)
        .toBe(false);
    }
    expect(startOperation.input.safeParse([{
      definitionId: 'td-SAMPLE', skills: ['sample-guide'],
    }]).success).toBe(false);
  });

  it.each([AGENT_OPERATIONS.inject, AGENT_OPERATIONS.injectSubagent])(
    '%s validates and preserves selections at the public boundary', (operationId) => {
      const operation = createAgentController({} as never, {} as never).operations
        .find(({ id }) => id === operationId)!;
      const ids = operationId === AGENT_OPERATIONS.inject ? ['sample-main'] : ['sample-main', 'sample-worker'];
      const parsed = operation.input.parse([...ids, {
        source: 'user', content: '', skills: ['sample-guide', 'other-guide', 'sample-guide'],
      }]) as unknown[];
      expect(parsed.at(-1)).toEqual({
        source: 'user', content: '', skills: ['sample-guide', 'other-guide'],
      });
      expect(operation.input.safeParse([...ids, {
        source: 'user', content: '', skills: [null],
      }]).success).toBe(false);
    },
  );

  it('rejects invalid template modes', () => {
    expect(startOperation.input.safeParse([{
      definitionId: 'td-AAAAAA',
      modeId: 'browser-skill',
    }]).success).toBe(false);
  });
});
