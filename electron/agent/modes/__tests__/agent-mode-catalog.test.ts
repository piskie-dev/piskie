import { describe, expect, it, vi } from 'vitest';

import type { TaskDefinition } from '../../../../shared/types/index.js';
import { browserSkillDirectorSpec } from '../../specs/builtin/browser-skill-director.js';
import { directorSpec } from '../../specs/builtin/director.js';
import { systemChatSpec } from '../../specs/builtin/system-chat.js';
import { SpecRegistry } from '../../specs/spec-registry.js';
import { AgentModeCatalog, AgentModeCatalogError } from '../agent-mode-catalog.js';
import { createBuiltinAgentModes } from '../builtin-agent-modes.js';

function taskDefinition(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    definitionId: 'td-AAAAAA',
    name: 'Reusable task',
    description: 'Reusable task description',
    purpose: 'general',
    promptTemplate: 'Run the reusable task',
    defaultModeId: 'plan',
    defaultApprovalMode: 'auto',
    metadata: { type: 'standard', boundEnvironmentIds: ['environment-old'] },
    createdAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  };
}

function harness() {
  const specs = new SpecRegistry();
  specs.register(directorSpec);
  specs.register(systemChatSpec);
  specs.register(browserSkillDirectorSpec);

  const runtime = {
    spec: directorSpec,
    getModule: vi.fn(() => ({})),
  };
  const agent = {
    startAgent: vi.fn(async (launch: any) => ({
      agentId: 'main-new',
      modeId: launch.initialModeId,
      runConfig: launch.runConfig,
    })),
    getAgent: vi.fn(() => runtime),
    setMode: vi.fn(() => true),
  };
  const definitions = new Map<string, TaskDefinition>();
  const catalog = new AgentModeCatalog(createBuiltinAgentModes(), {
    specs,
    agent: agent as never,
    resolveTaskDefinition: (definitionId) => definitions.get(definitionId) ?? null,
  });

  return { agent, catalog, definitions, runtime };
}

describe('AgentModeCatalog', () => {
  it('publishes all top-level modes and filters them by AgentSpec', () => {
    const { catalog } = harness();

    expect(catalog.listAvailable()).toEqual([
      { id: 'normal', label: 'Normal', runtimeSwitchable: true },
      { id: 'plan', label: 'Plan', runtimeSwitchable: true },
      { id: 'browser-skill', label: 'Browser Skill', runtimeSwitchable: false },
    ]);
    expect(catalog.listAvailable({ agentSpec: 'director' }).map(({ id }) => id))
      .toEqual(['normal', 'plan']);
    expect(catalog.listAvailable({ agentSpec: 'browser-skill-director' }).map(({ id }) => id))
      .toEqual(['plan', 'browser-skill']);
  });

  it.each(['normal', 'plan'] as const)(
    'resolves %s input as a one-off system-chat launch',
    async (modeId) => {
      const { agent, catalog } = harness();

      const result = await catalog.start({
        modeId,
        input: 'inspect the workspace',
        approvalMode: 'confirm',
      });

      expect(agent.startAgent).toHaveBeenCalledWith({
        runConfig: {
          name: 'inspect the workspace',
          description: 'inspect the workspace',
          promptTemplate: 'inspect the workspace',
        },
        agentSpec: systemChatSpec,
        initialModeId: modeId,
        initialApprovalMode: 'confirm',
        launchOptions: undefined,
      });
      expect(result.modeId).toBe(modeId);
    },
  );

  it('resolves Browser Skill input with its dedicated Director Spec', async () => {
    const { agent, catalog } = harness();

    await catalog.start({ modeId: 'browser-skill', input: 'capture example.com' });

    expect(agent.startAgent).toHaveBeenCalledWith(expect.objectContaining({
      runConfig: expect.objectContaining({ promptTemplate: 'capture example.com' }),
      agentSpec: browserSkillDirectorSpec,
      initialModeId: 'browser-skill',
    }));
  });

  it('copies Composer browser bindings into a one-off run config', async () => {
    const { agent, catalog } = harness();

    await catalog.start({
      modeId: 'normal',
      input: 'use the signed-in browser',
      environmentIds: ['environment-a', 'environment-b', 'environment-a'],
    });

    expect(agent.startAgent).toHaveBeenCalledWith(expect.objectContaining({
      runConfig: expect.objectContaining({
        bindings: {
          type: 'standard',
          boundEnvironmentIds: ['environment-a', 'environment-b'],
        },
      }),
    }));
  });

  it('snapshots a TaskDefinition and applies explicit start overrides', async () => {
    const { agent, catalog, definitions } = harness();
    definitions.set('td-AAAAAA', taskDefinition());

    await catalog.start({
      definitionId: 'td-AAAAAA',
      modeId: 'normal',
      approvalMode: 'confirm',
      workspace: '/new-workspace',
      environmentIds: ['environment-new'],
    });

    expect(agent.startAgent).toHaveBeenCalledWith({
      runConfig: {
        name: 'Reusable task',
        description: 'Reusable task description',
        promptTemplate: 'Run the reusable task',
        workspace: '/new-workspace',
        bindings: { type: 'standard', boundEnvironmentIds: ['environment-new'] },
      },
      agentSpec: directorSpec,
      initialModeId: 'normal',
      initialApprovalMode: 'confirm',
      launchOptions: undefined,
    });
  });

  it('rejects unavailable definitions, empty input, and unregistered modes before start', async () => {
    const { agent, catalog } = harness();

    await expect(catalog.start({ definitionId: 'td-missing' }))
      .rejects.toMatchObject<Partial<AgentModeCatalogError>>({ code: 'not-found' });
    await expect(catalog.start({ modeId: 'normal', input: '   ' }))
      .rejects.toMatchObject<Partial<AgentModeCatalogError>>({ code: 'invalid-input' });
    await expect(catalog.start({ modeId: 'missing', input: 'x' } as never))
      .rejects.toMatchObject<Partial<AgentModeCatalogError>>({ code: 'invalid-input' });
    expect(agent.startAgent).not.toHaveBeenCalled();
  });

  it('validates visibility and switchability before mutating runtime mode state', () => {
    const { agent, catalog, runtime } = harness();

    expect(() => catalog.setMode('agent-1', 'browser-skill')).toThrow(/not available/);
    expect(agent.setMode).not.toHaveBeenCalled();

    catalog.setMode('agent-1', 'plan');
    expect(agent.setMode).toHaveBeenCalledWith('agent-1', 'plan');

    runtime.getModule.mockReturnValueOnce(undefined);
    expect(() => catalog.setMode('agent-1', 'normal')).toThrow(/does not support/);
    expect(agent.setMode).toHaveBeenCalledTimes(1);
  });

  it('allows every Director with a PlanModule to enter plan temporarily', () => {
    const { agent, catalog, runtime } = harness();
    runtime.spec = browserSkillDirectorSpec;

    catalog.setMode('agent-1', 'plan');

    expect(agent.setMode).toHaveBeenCalledWith('agent-1', 'plan');
  });
});
