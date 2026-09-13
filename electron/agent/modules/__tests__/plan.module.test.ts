import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../agent-runs/plan-repository.js', () => ({
  planRepository: { readCurrentPlan: vi.fn(async () => null) },
}));
vi.mock('../../../agent-runs/task-board-service.js', () => ({
  taskBoardService: { readTaskBoard: vi.fn(async () => null) },
}));


import type { AgentHost } from '../../agent-host.js';
import { PlanModule } from '../plan.module.js';
import { taskBoardService } from '../../../agent-runs/task-board-service.js';

function setup(defaultModeId: string) {
  const emitStateChange = vi.fn();
  const module = new PlanModule();
  module.init({ id: 'main-1', emitStateChange } as unknown as AgentHost, {
    defaultModeId,
    mainAgentId: 'main-1',
  });
  return { emitStateChange, module };
}

describe('PlanModule mode restoration', () => {
  it('restores the complete persisted board before startup finishes', async () => {
    const board = {
      schemaVersion: 1 as const, taskSummary: 'Sample board',
      items: [
        { id: 'done', subject: 'Delivered sample', description: 'Verified result.', owner: 'worker-stopped', status: 'completed' as const, dependsOn: [] },
        { id: 'next', subject: 'Next sample', description: 'Complete the follow-up.', owner: 'main-1', status: 'in_progress' as const, dependsOn: ['done'] },
      ],
    };
    vi.mocked(taskBoardService.readTaskBoard).mockResolvedValueOnce(board);
    const { module, emitStateChange } = setup('normal');
    await module.onStart();
    expect(module.getTaskBoard()).toEqual({ taskSummary: board.taskSummary, items: board.items });
    expect(emitStateChange).toHaveBeenCalled();
  });
  it('falls back to normal when the session starts directly in plan mode', () => {
    const { module } = setup('plan');

    module.exitPlan();
    expect(module.getMode()).toBe('normal');
  });

  it('restores the mode that entered plan', () => {
    const { module } = setup('browser-skill');

    module.setMode('plan');

    module.exitPlan();
    expect(module.getMode()).toBe('browser-skill');
  });

  it('uses the same restoration rule for future modes', () => {
    const { module } = setup('future-mode');

    module.setMode('plan');
    module.setMode('plan');

    module.exitPlan();
    expect(module.getMode()).toBe('future-mode');
  });

  it('clears a stale return target when plan is left explicitly', () => {
    const { module } = setup('browser-skill');

    module.setMode('plan');
    module.setMode('normal');
    module.setMode('plan');

    module.exitPlan();
    expect(module.getMode()).toBe('normal');
  });
});
