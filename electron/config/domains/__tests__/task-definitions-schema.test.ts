import { describe, expect, it } from 'vitest';
import {
  taskDefinitionsReadSchema,
  taskDefinitionsStoredSchema,
  taskDefinitionsWriteSchema,
} from '../task-definitions.adapter.js';

const definitionId = 'td-2HsRtt';
const definition = {
  name: 'Reusable task',
  description: 'Task description',
  purpose: 'general' as const,
  promptTemplate: 'Run the task.',
};

describe('Task Definitions Domain schema', () => {
  it('accepts non-empty definition IDs and rejects empty keys', () => {
    expect(taskDefinitionsWriteSchema.safeParse({
      definitions: { [definitionId]: definition },
    }).success).toBe(true);
    expect(taskDefinitionsWriteSchema.safeParse({
      definitions: { '': definition },
    }).success).toBe(false);

    const persisted = {
      ...definition,
      defaultModeId: 'normal',
      defaultApprovalMode: 'confirm',
      createdAt: '2026-08-14T00:00:00.000Z',
    };
    expect(taskDefinitionsReadSchema.safeParse({
      revision: 1,
      definitions: { [definitionId]: persisted },
    }).success).toBe(true);
    expect(taskDefinitionsStoredSchema.safeParse({
      revision: 1,
      definitions: { '   ': persisted },
    }).success).toBe(false);
  });

  it('requires purpose on writes and classifies legacy stored definitions at read time', () => {
    const legacyGeneral = {
      name: definition.name,
      description: definition.description,
      promptTemplate: definition.promptTemplate,
    };
    expect(taskDefinitionsWriteSchema.safeParse({
      definitions: { [definitionId]: legacyGeneral },
    }).success).toBe(false);

    const parsed = taskDefinitionsStoredSchema.parse({
      revision: 1,
      definitions: {
        general: {
          ...legacyGeneral,
          defaultModeId: 'normal',
          defaultApprovalMode: 'confirm',
          createdAt: '2026-08-14T00:00:00.000Z',
        },
        messaging: {
          ...legacyGeneral,
          promptTemplate: '',
          defaultModeId: 'normal',
          defaultApprovalMode: 'auto',
          createdAt: '2026-08-14T00:00:00.000Z',
        },
      },
    });

    expect(parsed.definitions.general?.purpose).toBe('general');
    expect(parsed.definitions.messaging?.purpose).toBe('messaging');
  });

  it('ignores retired stored settings while keeping new writes strict', () => {
    const persisted = {
      ...definition,
      advancedSettings: {
        backgroundMode: false,
        retiredSetting: 'ignored',
        fingerprint: {
          platform: 'linux',
          retiredFingerprintSetting: true,
        },
      },
      metadata: {
        type: 'standard',
        boundEnvironmentIds: ['browser-a'],
        retiredBinding: true,
      },
      defaultModeId: 'normal',
      defaultApprovalMode: 'confirm',
      createdAt: '2026-08-14T00:00:00.000Z',
    };

    const parsed = taskDefinitionsStoredSchema.parse({
      revision: 1,
      definitions: { [definitionId]: persisted },
      retiredRoot: true,
    });
    expect(parsed.definitions[definitionId]?.advancedSettings).toEqual({
      backgroundMode: false,
      fingerprint: { platform: 'linux' },
    });
    expect(parsed.definitions[definitionId]?.metadata).toEqual({
      type: 'standard',
      boundEnvironmentIds: ['browser-a'],
    });

    expect(taskDefinitionsWriteSchema.safeParse({
      definitions: {
        [definitionId]: {
          ...definition,
          advancedSettings: { retiredSetting: 'rejected' },
        },
      },
    }).success).toBe(false);
    expect(taskDefinitionsWriteSchema.safeParse({
      definitions: {
        [definitionId]: {
          ...definition,
          metadata: { type: 'standard', retiredBinding: true },
        },
      },
    }).success).toBe(false);
  });
});
