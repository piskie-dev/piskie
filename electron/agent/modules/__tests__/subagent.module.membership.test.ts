/**
 * 浏览器 Worker 的环境成员校验：会话当前集合非空时 browserEnvironmentId 必填且必须是成员；
 * 集合为空时只能省略；集合外的 ID 在存在性 / 占用检查之前就被拒绝。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '../../agent-host.js';
import type { SubagentConfig } from '../../../../shared/types/index.js';
import type { AgentRunHeader } from '../../../../shared/types/agent-control.js';
import { AgentRunPaths } from '../../../agent-runs/agent-run-paths.js';
import { SubagentModule } from '../subagent.module.js';

const runtimeMock = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  getEnvironment: vi.fn((id: string) => (id === 'environment-a' || id === 'environment-b'
    ? { id, name: `Sample ${id}`, userDataId: `data-${id}` }
    : undefined)),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test', getAppPath: () => '/tmp/piskie-test' },
}));
vi.mock('../../../services/browser-environment-runtime.js', () => ({
  browserEnvironmentRuntime: { getEnvironment: runtimeMock.getEnvironment },
}));
vi.mock('../../agent-runtime.js', () => ({
  AgentRuntime: class {
    readonly id: string;
    readonly spec: { assignment: 'question' | 'work-package' };
    approvalMode: 'auto' | 'confirm' = 'auto';
    constructor(config: { id: string; spec: { assignment: 'question' | 'work-package' } }) {
      runtimeMock.configs.push(config as unknown as Record<string, unknown>);
      this.id = config.id;
      this.spec = config.spec;
    }
    async start(): Promise<void> {}
    getEffectiveWorkspace(): string { return '/sample/worker-workspace'; }
    async destroy(): Promise<void> {}
    hasFailed(): boolean { return false; }
    setApprovalMode(mode: 'auto' | 'confirm'): void { this.approvalMode = mode; }
  },
}));

function createHost(sessionIds: readonly string[]) {
  const mainAgentId = `membership-${Math.random().toString(16).slice(2)}`;
  let header: AgentRunHeader = {
    agentId: mainAgentId, agentSpec: 'director', modeId: 'normal',
    runConfig: { name: mainAgentId, description: '', promptTemplate: '' },
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    currentModel: 'provider::model', approvalMode: 'auto', childAgents: [],
  };
  const store = {
    paths: new AgentRunPaths('/tmp/piskie-test'),
    read: vi.fn(() => []),
    readHeader: vi.fn(() => header),
    writeHeader: vi.fn((_id: string, next: AgentRunHeader) => { header = next; }),
  };
  return {
    id: mainAgentId, mainAgentId, phase: 'running', spec: { name: 'director' },
    currentModel: 'provider::model', reasoningOverride: { kind: 'disabled' }, approvalMode: 'auto',
    getConversationStore: () => store, appendConversationEntry: vi.fn(), emitStateChange: vi.fn(),
    getBrowserEnvironmentIds: () => sessionIds,
  } as unknown as AgentHost;
}

function createModule(sessionIds: readonly string[]) {
  const module = new SubagentModule() as unknown as SubagentModule & { createSubagent: (config: SubagentConfig) => Promise<string> };
  let sequence = 0;
  module.init(createHost(sessionIds), {
    runConfig: { name: 'membership', description: '', promptTemplate: '' },
    allocateAgentId: () => `membership-worker-${++sequence}`,
  });
  return module;
}

const browserWorker = (browserEnvironmentId?: string): SubagentConfig => ({
  type: 'browser-worker', subject: 'Sample browsing', prompt: 'Open the sample site', ...(browserEnvironmentId ? { browserEnvironmentId } : {}),
});

afterEach(() => {
  runtimeMock.getEnvironment.mockClear();
  runtimeMock.configs.length = 0;
});

describe('browser environment membership', () => {
  it('requires an id from the current set when the session has environments', async () => {
    const module = createModule(['environment-a', 'environment-b']);
    try {
      await expect(module.createSubagent(browserWorker())).rejects.toThrow('必须指定 browserEnvironmentId，可选：environment-a / environment-b');
      expect(runtimeMock.getEnvironment).not.toHaveBeenCalled();
    } finally { await module.onDestroy(); }
  });

  it('rejects an id outside the current set before resolving the environment', async () => {
    const module = createModule(['environment-a']);
    try {
      await expect(module.createSubagent(browserWorker('environment-b'))).rejects.toThrow('浏览器环境 environment-b 不在当前会话中，可选：environment-a');
      expect(runtimeMock.getEnvironment).not.toHaveBeenCalled();
      expect(runtimeMock.configs).toHaveLength(0);
    } finally { await module.onDestroy(); }
  });

  it('creates the worker with a member id and binds that environment', async () => {
    const module = createModule(['environment-a', 'environment-b']);
    try {
      const id = await module.createSubagent(browserWorker('environment-b'));
      expect(id).toBe('membership-worker-1');
      expect(runtimeMock.configs.at(-1)).toMatchObject({
        options: { browserBinding: { browserId: 'environment-environment-b', userDataId: 'data-environment-b' } },
      });
    } finally { await module.onDestroy(); }
  });

  it('allows a temporary browser only while the session has no environments', async () => {
    const module = createModule([]);
    try {
      expect(await module.createSubagent(browserWorker())).toBe('membership-worker-1');
      await expect(module.createSubagent(browserWorker('environment-a'))).rejects.toThrow('浏览器环境 environment-a 不在当前会话中，可选：（无）');
    } finally { await module.onDestroy(); }
  });

  it('does not apply the membership rule to local workers', async () => {
    const module = createModule(['environment-a']);
    try {
      expect(await module.createSubagent({ type: 'local-worker', subject: 'Sample task', prompt: 'Inspect files' })).toBe('membership-worker-1');
    } finally { await module.onDestroy(); }
  });
});
