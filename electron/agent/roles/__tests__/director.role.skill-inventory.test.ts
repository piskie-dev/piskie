import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
}));
vi.mock('../../../services/paths.service.js', () => ({
  pathsService: {
    ensureWorkspace: vi.fn().mockResolvedValue(undefined),
    getDefaultWorkspaceDir: () => '/default/workspace',
  },
}));
vi.mock('../../../services/browser-environment-runtime.js', () => ({ browserEnvironmentRuntime: {} }));

import { DirectorRole } from '../director.role.js';
import type { AgentHost } from '../../agent-host.js';
import type { RuntimeOptions } from '../role.js';

function createCatalog() {
  return {
    listManagedSkills: vi.fn().mockResolvedValue([
      {
        name: 'xhs-helper',
        type: 'browser',
        scope: 'user',
        path: '/s/xhs-helper',
        description: '小红书助手',
        enabled: true,
        executionType: 'knowledge',
      },
    ]),
    getLoadedSkillModule: vi.fn(() => undefined),
    getSkillResourceRoot: vi.fn(() => undefined),
    getSkillDocs: vi.fn().mockResolvedValue(''),
  };
}

function createHost(catalog: ReturnType<typeof createCatalog>) {
  return {
    id: 'agent-1',
    getControlState: vi.fn(() => ({ pendingToolCall: null })),
    getSkillCatalog: () => catalog,
    addUserMessage: vi.fn(),
  } as unknown as AgentHost;
}

describe('DirectorRole 会话恢复的技能清单重注入', () => {
  it('resume 时重新渲染清单并重新快照 manifest，同时跳过初始任务注入', async () => {
    const catalog = createCatalog();
    const host = createHost(catalog);
    const role = new DirectorRole();

    await role.onStart(host, {
      runConfig: {
        name: 'run',
        description: '初始任务',
        promptTemplate: '初始任务',
      },
      isResume: true,
    } as unknown as RuntimeOptions);

    expect(catalog.listManagedSkills).toHaveBeenCalledTimes(1);
    const snapshot = (role as unknown as { skillInventory: { snapshot: { entries: Record<string, unknown> } } })
      .skillInventory.snapshot;
    expect(snapshot.entries['xhs-helper']).toBeDefined();
    expect(host.addUserMessage).not.toHaveBeenCalled();
  });

  it('首次启动同样构建清单且注入初始任务', async () => {
    const catalog = createCatalog();
    const host = createHost(catalog);
    const role = new DirectorRole();

    await role.onStart(host, {
      runConfig: {
        name: 'run',
        description: '初始任务',
        promptTemplate: '初始任务',
      },
    } as unknown as RuntimeOptions);

    expect(catalog.listManagedSkills).toHaveBeenCalledTimes(1);
    expect(host.addUserMessage).toHaveBeenCalledWith({
      text: '初始任务',
      images: undefined,
      subtype: 'system_task',
    });
  });
});

describe('DirectorRole 中断快照', () => {
  it('保留仍登记在运行时中的 Worker', () => {
    const child = {
      id: 'worker-1',
      config: {
        mode: 'browser' as const,
        subject: '继续构建 Skill',
        taskIds: ['build-skill'],
      },
      createdAt: 1_786_000_000_000,
    };
    const header = {
      agentId: 'agent-1',
      agentSpec: 'director',
      modeId: 'normal',
      runConfig: { name: 'run', description: 'task', promptTemplate: 'task' },
      createdAt: '2026-08-15T00:00:00.000Z',
      lastActiveAt: '2026-08-15T01:00:00.000Z',
      currentModel: 'provider::model',
      approvalMode: 'confirm' as const,
      childAgents: [child],
    };
    const writeHeader = vi.fn();
    const host = {
      id: 'agent-1',
      mainAgentId: 'agent-1',
      buildHeader: vi.fn(() => header),
      getConversationStore: () => ({ writeHeader }),
      emitStateChange: vi.fn(),
    } as unknown as AgentHost;

    new DirectorRole().onAfterInterrupt(host);

    expect(writeHeader).toHaveBeenCalledWith('agent-1', header);
    expect(header.childAgents).toEqual([child]);
    expect(host.emitStateChange).toHaveBeenCalledOnce();
  });
});
