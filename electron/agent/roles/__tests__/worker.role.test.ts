import { describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/piskie-worker-role-test',
    getAppPath: () => '/tmp/piskie-worker-role-test',
  },
}));

import { WorkerRole } from '../worker.role.js';
import { browserSkillBuilderIdentity } from '../../prompts/browser-skill/builder.js';
import type { AgentHost } from '../../agent-host.js';
import type { PromptContext } from '../../prompts/types.js';
import type { RuntimeOptions } from '../role.js';

function makeOptions(): RuntimeOptions {
  return {
    mainAgentId: 'main-1',
    workspace: '/workspace',
    subagentConfig: {
      mode: 'local',
      subject: 'PARENT_ONLY_ASSIGNMENT_SUBJECT',
      taskIds: ['task-a'],
      prompt: 'UNIQUE_ASSIGNMENT_PROMPT',
      skills: [],
    },
    assignmentTaskBoardSnapshot: {
      taskSummary: 'Board',
      items: [{
        id: 'task-a',
        subject: 'Task A',
        status: 'pending',
        owner: null,
        dependsOn: [],
        assignedHere: true,
      }],
    },
  } as RuntimeOptions;
}

function makeHost(addUserMessage = vi.fn()): AgentHost {
  return {
    id: 'worker-1',
    approvalMode: 'auto',
    getSkillCatalog: () => null,
    getBrowserControl: () => null,
    getModule: () => undefined,
    addUserMessage,
  } as unknown as AgentHost;
}

describe('WorkerRole Assignment context', () => {
  it('resolves execute mode from the live approval mode for every tool batch', () => {
    const role = new WorkerRole();
    const host = makeHost() as AgentHost & { approvalMode: 'auto' | 'confirm' };
    const { executeMode } = role.configureLoop(host);

    expect(executeMode).toBeTypeOf('function');
    const resolveMode = executeMode as () => 'sequential' | 'parallel';
    expect(resolveMode()).toBe('parallel');

    host.approvalMode = 'confirm';
    expect(resolveMode()).toBe('sequential');
  });

  it('adds exactly one creation message and does not put Assignment subject in it', async () => {
    const addUserMessage = vi.fn();
    const host = makeHost(addUserMessage);
    const role = new WorkerRole();
    const options = makeOptions();

    await role.onStart(host, options);
    await role.onStart(host, { ...options, isResume: true });

    expect(addUserMessage).toHaveBeenCalledTimes(1);
    const [input] = addUserMessage.mock.calls[0];
    expect(input.subtype).toBe('assignment');
    expect(input.text).toContain('UNIQUE_ASSIGNMENT_PROMPT');
    expect(input.text).not.toContain('PARENT_ONLY_ASSIGNMENT_SUBJECT');
  });

  it('keeps Assignment subject out of the per-turn PromptContext', () => {
    const role = new WorkerRole();
    const options = makeOptions();
    const context = {
      role: 'worker',
      flowName: 'browser-skill-builder',
      canManageAgentRuns: false,
      skillDocs: '',
      workspaceDir: '/workspace',
      tempDir: '/unused',
    } as PromptContext;

    role.enrichPromptContext(context, makeHost(), options);

    expect(context.flowName).toBe('browser-skill-builder');
    expect(context.tempDir).toBe(path.join(os.tmpdir(), 'piskie', 'worker-1'));
    expect(JSON.stringify(context)).not.toContain('PARENT_ONLY_ASSIGNMENT_SUBJECT');
    expect(browserSkillBuilderIdentity.render(context)).not.toContain('PARENT_ONLY_ASSIGNMENT_SUBJECT');
  });
});
