import { describe, expect, it } from 'vitest';

import { AGENT_OPERATIONS } from '../../../../shared/electron-contracts/agents.js';
import { createAgentController } from '../agent-controller.js';

const startOperation = createAgentController({} as never, {} as never).operations
  .find(({ id }) => id === AGENT_OPERATIONS.start);

if (!startOperation) throw new Error('agents.start operation missing');

describe('agents.start public schema', () => {
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

  it('rejects invalid template modes', () => {
    expect(startOperation.input.safeParse([{
      definitionId: 'td-AAAAAA',
      modeId: 'browser-skill',
    }]).success).toBe(false);
  });
});
