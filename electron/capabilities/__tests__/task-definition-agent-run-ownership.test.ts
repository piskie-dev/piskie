import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRunHeader } from '../../../shared/types/agent-control.js';
import type { TaskDefinition } from '../../../shared/types/index.js';
import { ConversationStore } from '../../agent-runs/conversation-store.js';
import { AgentRunApplication } from '../agent-runs/agent-run-application.js';
import { TaskDefinitionApplication } from '../task-definitions/task-definition-application.js';

const DEFINITION_ID = 'td-AAAAAA';
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-owner-boundaries-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('TaskDefinition and AgentRun ownership boundaries', () => {
  it('keeps an existing AgentRun when its TaskDefinition is deleted', async () => {
    const conversation = seededConversation();
    const definitions = definitionHarness();

    await definitions.application.delete(DEFINITION_ID);

    expect(definitions.application.list()).toEqual([]);
    expect(agentRuns(conversation).list().map(({ agentId }) => agentId)).toEqual(['main-run']);
    expect(conversation.readHeader('main-run')).toMatchObject({ agentId: 'main-run' });
  });

  it('keeps TaskDefinition configuration when an AgentRun is deleted', async () => {
    const conversation = seededConversation();
    const definitions = definitionHarness();
    const removeAgentBindings = vi.fn(async () => undefined);

    await agentRuns(conversation, removeAgentBindings).delete('main-run');

    expect(conversation.readHeader('main-run')).toBeNull();
    expect(removeAgentBindings).toHaveBeenCalledWith('main-run');
    expect(definitions.application.list()).toEqual([definition()]);
    expect(definitions.config.createPatchPlan).not.toHaveBeenCalled();
  });
});

function definitionHarness() {
  let current = {
    revision: 1,
    definitions: { [DEFINITION_ID]: withoutId(definition()) },
  };
  let pendingPatch: Array<{ op: string; path: string }> = [];
  const config = {
    show: vi.fn(async () => structuredClone(current)),
    createPatchPlan: vi.fn(async (_domain: string, patch: typeof pendingPatch) => {
      pendingPatch = patch;
      return { id: 'plan-1' };
    }),
    validate: vi.fn(async () => ({ id: 'plan-1' })),
    apply: vi.fn(async () => {
      const definitionId = pendingPatch[0]!.path.slice('/definitions/'.length);
      const definitions = structuredClone(current.definitions) as Record<string, unknown>;
      delete definitions[definitionId];
      current = { revision: current.revision + 1, definitions } as typeof current;
      return { revision: current.revision };
    }),
  };
  const application = new TaskDefinitionApplication({
    config,
    definitions: {
      get: (definitionId: string) => (
        current.definitions[definitionId] ? definition() : null
      ),
      list: () => (current.definitions[DEFINITION_ID] ? [definition()] : []),
    },
    messaging: { getBotConfigs: () => [] },
  } as never);
  return { application, config };
}

function agentRuns(
  conversation: ConversationStore,
  removeAgentBindings = vi.fn(async () => undefined),
): AgentRunApplication {
  return new AgentRunApplication({
    agent: {
      getConversationStore: () => conversation,
      deleteAgentRun: async (agentId: string) => conversation.deleteAgentRun(agentId),
    },
    plans: {},
    compactions: {},
    messaging: { removeAgentBindings },
  } as never);
}

function seededConversation(): ConversationStore {
  const conversation = new ConversationStore(root);
  conversation.writeHeader('main-run', header());
  return conversation;
}

function definition(): TaskDefinition {
  return {
    definitionId: DEFINITION_ID,
    name: 'Reusable task',
    description: 'Reusable task',
    purpose: 'general',
    promptTemplate: 'Complete the reusable task.',
    defaultModeId: 'normal',
    defaultApprovalMode: 'confirm',
    createdAt: '2026-08-19T00:00:00.000Z',
  };
}

function withoutId(value: TaskDefinition): Omit<TaskDefinition, 'definitionId'> {
  const stored = structuredClone(value) as Partial<TaskDefinition>;
  delete stored.definitionId;
  return stored as Omit<TaskDefinition, 'definitionId'>;
}

function header(): AgentRunHeader {
  return {
    agentId: 'main-run',
    agentSpec: 'director',
    modeId: 'normal',
    runConfig: {
      name: 'Persisted run',
      description: 'Independent snapshot',
      promptTemplate: 'Continue from disk.',
    },
    createdAt: '2026-08-19T00:00:00.000Z',
    lastActiveAt: '2026-08-19T00:00:00.000Z',
    currentModel: 'provider::model',
    approvalMode: 'confirm',
    childAgents: [],
  };
}
