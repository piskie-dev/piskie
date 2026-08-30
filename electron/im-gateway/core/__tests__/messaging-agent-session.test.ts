import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskDefinition } from '../../../../shared/types/index.js';
import { IM_CLEAR_COMMAND_HINT } from '../../commands/command-messages.js';
import { MessagingAgentSession } from '../../messaging-agent-session.js';
import type { MessagingConversation } from '../../config-agent-bindings.js';

const definitions = vi.hoisted(() => new Map<string, TaskDefinition>());
vi.mock('../../../core/storage/index.js', () => ({
  taskDefinitionStore: {
    get: (definitionId: string) => definitions.get(definitionId) ?? null,
  },
}));

import {
  ImTaskDefinitionPurposeError,
  ImTaskDefinitionUnavailableError,
  resolveImAgentLaunch,
} from '../agent-launch.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

function definition(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    definitionId: 'td-support',
    name: '客服任务',
    description: '接待用户',
    purpose: 'messaging',
    promptTemplate: '解决用户问题',
    systemPrompt: '保持回答简洁。',
    defaultModeId: 'plan',
    defaultApprovalMode: 'auto',
    metadata: { type: 'standard', boundEnvironmentIds: ['browser-1'] },
    createdAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  };
}

function bot(overrides: Partial<MessagingConnectionConfig> = {}): MessagingConnectionConfig {
  return {
    id: 'bot-001',
    channelType: 'feishu',
    name: '客服机器人',
    definitionId: 'td-support',
    appId: 'app',
    appSecret: 'secret',
    ...overrides,
  };
}

beforeEach(() => {
  definitions.clear();
});

describe('IM Agent launch resolution', () => {
  it('snapshots a TaskDefinition into a one-off AgentRun launch', () => {
    const source = definition();
    definitions.set(source.definitionId, source);

    const resolved = resolveImAgentLaunch(bot(), { kind: 'group', id: 'oc_123456' });

    expect(resolved.conversation).toEqual({
      botId: 'bot-001',
      peerKind: 'group',
      peerId: 'oc_123456',
    });
    expect(resolved.launch).toMatchObject({
      agentSpec: { name: 'director' },
      initialModeId: 'plan',
      initialApprovalMode: 'auto',
      runConfig: {
        name: '客服任务 · 客服机器人 · 群 oc_123456',
        description: '接待用户',
        promptTemplate: '解决用户问题',
        bindings: { type: 'standard', boundEnvironmentIds: ['browser-1'] },
      },
    });
    expect(resolved.launch.runConfig.systemPrompt).toContain('保持回答简洁。');
    expect(resolved.launch.runConfig.systemPrompt).toContain(IM_CLEAR_COMMAND_HINT);

    resolved.launch.runConfig.bindings!.boundEnvironmentIds!.push('browser-2');
    expect(source.metadata?.boundEnvironmentIds).toEqual(['browser-1']);
  });

  it('rejects an unbound or missing TaskDefinition', () => {
    expect(() => resolveImAgentLaunch(bot({ definitionId: undefined }), {
      kind: 'direct',
      id: 'user-1',
    })).toThrow(ImTaskDefinitionUnavailableError);
    expect(() => resolveImAgentLaunch(bot({ definitionId: 'td-missing' }), {
      kind: 'direct',
      id: 'user-1',
    })).toThrow('Task Definition 不存在: td-missing');
  });

  it('rejects a general-purpose Task Definition', () => {
    definitions.set('td-support', definition({ purpose: 'general' }));

    expect(() => resolveImAgentLaunch(bot(), { kind: 'direct', id: 'user-1' }))
      .toThrow(ImTaskDefinitionPurposeError);
  });
});

describe('MessagingAgentSession', () => {
  it('reuses an active binding and resumes a cold disk-backed AgentRun', async () => {
    const active = conversation('active');
    const cold = conversation('cold');
    const bindings = inMemoryBindings([[active, 'main-active'], [cold, 'main-cold']]);
    const agents = {
      hasAgentInMemory: vi.fn((agentId: string) => agentId === 'main-active'),
      resumeAgent: vi.fn(async (agentId: string) => ({ agentId })),
      startAgent: vi.fn(),
      stopAgent: vi.fn(),
    };
    const sessions = new MessagingAgentSession(agents as never, bindings);
    const resolveLaunch = vi.fn(launch);

    await expect(sessions.ensure(active, resolveLaunch)).resolves.toBe('main-active');
    await expect(sessions.ensure(cold, resolveLaunch)).resolves.toBe('main-cold');
    expect(agents.resumeAgent).toHaveBeenCalledWith('main-cold', { autoStart: false });
    expect(agents.startAgent).not.toHaveBeenCalled();
    expect(resolveLaunch).not.toHaveBeenCalled();
  });

  it('starts and persists a new AgentRun when the bound AgentRun cannot resume', async () => {
    const target = conversation('stale');
    const bindings = inMemoryBindings([[target, 'main-stale']]);
    const agents = {
      hasAgentInMemory: vi.fn(() => false),
      resumeAgent: vi.fn(async () => null),
      startAgent: vi.fn(async () => ({ agentId: 'main-new' })),
      stopAgent: vi.fn(),
    };
    const sessions = new MessagingAgentSession(agents as never, bindings);
    const resolveLaunch = vi.fn(launch);

    await expect(sessions.ensure(target, resolveLaunch)).resolves.toBe('main-new');
    expect(bindings.set).toHaveBeenCalledWith(target, 'main-new');
    expect(resolveLaunch).toHaveBeenCalledOnce();
  });

  it('serializes concurrent starts for the same natural conversation', async () => {
    const target = conversation('same');
    const bindings = inMemoryBindings();
    let release!: () => void;
    const firstStart = new Promise<{ agentId: string }>((resolve) => {
      release = () => resolve({ agentId: 'main-new' });
    });
    const agents = {
      hasAgentInMemory: vi.fn((agentId: string) => agentId === 'main-new'),
      resumeAgent: vi.fn(),
      startAgent: vi.fn(() => firstStart),
      stopAgent: vi.fn(),
    };
    const sessions = new MessagingAgentSession(agents as never, bindings);
    const resolveLaunch = vi.fn(launch);

    const first = sessions.ensure(target, resolveLaunch);
    const second = sessions.ensure(target, resolveLaunch);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(['main-new', 'main-new']);
    expect(agents.startAgent).toHaveBeenCalledTimes(1);
    expect(resolveLaunch).toHaveBeenCalledTimes(1);
  });
});

function launch() {
  return {
    runConfig: { name: 'Task', description: 'Task', promptTemplate: 'Task' },
    agentSpec: { name: 'director' },
    initialModeId: 'normal',
    initialApprovalMode: 'confirm',
  } as never;
}

function conversation(peerId: string): MessagingConversation {
  return { botId: 'bot-1', peerKind: 'direct', peerId };
}

function inMemoryBindings(entries: Array<[MessagingConversation, string]> = []) {
  const values = new Map(entries.map(([key, agentId]) => [JSON.stringify(key), agentId]));
  return {
    get: vi.fn(async (key: MessagingConversation) => values.get(JSON.stringify(key)) ?? null),
    set: vi.fn(async (key: MessagingConversation, agentId: string) => {
      values.set(JSON.stringify(key), agentId);
    }),
  };
}
