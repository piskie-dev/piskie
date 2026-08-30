import { describe, expect, it, vi } from 'vitest';

import { CompactTaskDefinitionIdAllocator } from '../../../core/ids/task-definition-id-allocator.js';
import { TaskDefinitionApplication } from '../task-definition-application.js';

const TASK_DEFINITION_ID_PATTERN = /^td-[0-9A-Za-z]{6}$/;

function applicationHarness(initialDefinitions: Record<string, Record<string, unknown>> = {}) {
  let current: {
    revision: number;
    definitions: Record<string, Record<string, unknown>>;
  } = { revision: 0, definitions: structuredClone(initialDefinitions) };
  let pendingPatch: { op: string; path: string; value?: Record<string, unknown> } | undefined;
  let rejectNextApplyForRevisionConflict = false;
  const config = {
    projectWrite: vi.fn((_domain: string, value: unknown) => structuredClone(value)),
    show: vi.fn(async () => structuredClone(current)),
    createPatchPlan: vi.fn(async (
      _domain: string,
      patch: Array<{ op: string; path: string; value?: Record<string, unknown> }>,
    ) => {
      pendingPatch = patch[0];
      return { id: 'plan-1' };
    }),
    validate: vi.fn(async () => ({ id: 'plan-1' })),
    apply: vi.fn(async () => {
      if (rejectNextApplyForRevisionConflict) {
        rejectNextApplyForRevisionConflict = false;
        current = {
          revision: current.revision + 1,
          definitions: {
            ...current.definitions,
            'td-AAAAAA': storedDefinition('Concurrent task'),
          },
        };
        throw Object.assign(new Error('Configuration revision changed'), {
          code: 'CONFIG_REVISION_CONFLICT',
        });
      }
      const patch = pendingPatch!;
      const definitionId = patch.path.slice('/definitions/'.length);
      current = {
        revision: current.revision + 1,
        definitions: {
          ...current.definitions,
          [definitionId]: {
            ...patch.value,
            createdAt: current.definitions[definitionId]?.createdAt
              ?? '2026-08-14T00:00:00.000Z',
          },
        },
      };
      return { revision: current.revision };
    }),
  };
  const candidates = ['AAAAAA', 'b8Z2Km'];
  const definitions = {
    get: (definitionId: string) => current.definitions[definitionId]
      ? { definitionId, ...structuredClone(current.definitions[definitionId]) }
      : null,
    list: () => Object.entries(current.definitions)
      .map(([definitionId, value]) => ({ definitionId, ...structuredClone(value) })),
  };
  const application = new TaskDefinitionApplication({
    config,
    definitions,
    messaging: { getBotConfigs: () => [] },
    definitionIds: new CompactTaskDefinitionIdAllocator(() => candidates.shift()!, 4),
  } as never);
  return {
    application,
    config,
    rejectNextApply: () => {
      rejectNextApplyForRevisionConflict = true;
    },
  };
}

describe('persistent Task Definition ID ownership', () => {
  it('allocates a td-prefixed ID without accepting an ID in create input', async () => {
    const { application, config } = applicationHarness();

    const created = await application.create({
      name: 'Reusable task',
      description: 'Quick task',
      purpose: 'general',
      promptTemplate: 'hello',
    });

    expect(created.definitionId).toMatch(TASK_DEFINITION_ID_PATTERN);
    expect(config.createPatchPlan).toHaveBeenCalledWith('task-definitions', [
      expect.objectContaining({
        op: 'add',
        path: `/definitions/${created.definitionId}`,
      }),
    ]);
  });

  it('does not overwrite an occupied candidate', async () => {
    const { application } = applicationHarness({
      'td-AAAAAA': storedDefinition('Existing task'),
    });

    const created = await application.create({
      name: 'New task',
      description: 'New task',
      purpose: 'general',
      promptTemplate: 'new task',
    });

    expect(created.definitionId).toBe('td-b8Z2Km');
  });

  it('refreshes the snapshot and reallocates after a revision conflict', async () => {
    const { application, config, rejectNextApply } = applicationHarness();
    rejectNextApply();

    const created = await application.create({
      name: 'Concurrent-safe task',
      description: 'Created after a concurrent write',
      purpose: 'general',
      promptTemplate: 'continue',
    });

    expect(created.definitionId).toBe('td-b8Z2Km');
    expect(config.apply).toHaveBeenCalledTimes(2);
  });

  it('updates submitted fields while preserving the immutable creation timestamp', async () => {
    const { application, config } = applicationHarness({
      'td-AAAAAA': storedDefinition('Original task'),
    });

    const updated = await application.update('td-AAAAAA', { name: 'Updated task' });

    expect(updated).toMatchObject({
      definitionId: 'td-AAAAAA',
      name: 'Updated task',
      description: 'Original task',
      promptTemplate: 'Original task',
      createdAt: '2026-08-14T00:00:00.000Z',
    });
    expect(config.createPatchPlan).toHaveBeenCalledWith('task-definitions', [
      expect.objectContaining({
        op: 'replace',
        path: '/definitions/td-AAAAAA',
        value: expect.not.objectContaining({ createdAt: expect.anything() }),
      }),
    ]);
  });
});

function storedDefinition(name: string): Record<string, unknown> {
  return {
    name,
    description: name,
    purpose: 'general',
    promptTemplate: name,
    defaultModeId: 'normal',
    defaultApprovalMode: 'confirm',
    createdAt: '2026-08-14T00:00:00.000Z',
  };
}
