import { describe, expect, it } from 'vitest';

import { TASK_DEFINITION_OPERATIONS } from '../../../../shared/electron-contracts/task-definitions.js';
import { createTaskDefinitionController } from '../task-definition-controller.js';

const createOperation = createTaskDefinitionController({} as never)
  .find(({ id }) => id === TASK_DEFINITION_OPERATIONS.create);

if (!createOperation) throw new Error('task-definitions.create operation missing');

const definition = {
  name: 'Reusable task',
  description: 'Reusable task description',
  purpose: 'general',
  promptTemplate: 'Run the task',
  defaultModeId: 'normal',
  defaultApprovalMode: 'confirm',
};

describe('Task Definition public schema', () => {
  it('accepts only normal/plan definitions without an AgentSpec alias', () => {
    expect(createOperation.input.safeParse([definition]).success).toBe(true);
    expect(createOperation.input.safeParse([{
      ...definition,
      defaultModeId: 'browser-skill',
    }]).success).toBe(false);
    expect(createOperation.input.safeParse([{
      ...definition,
      agentType: 'system-chat',
    }]).success).toBe(false);
    expect(createOperation.input.safeParse([{
      ...definition,
      purpose: 'unknown',
    }]).success).toBe(false);
  });
});
