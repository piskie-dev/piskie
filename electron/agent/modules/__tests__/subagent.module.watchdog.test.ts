import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import type { AgentEngine } from '../../agent-engine.js';
import type { AgentHost } from '../../agent-host.js';
import type {
  AgentInputEvent,
  ConversationEntry,
  SubagentConfig,
} from '../../../../shared/types/index.js';
import type { ATAEventEnvelope } from '../../ata/ata-event-envelope.js';
import type { AgentRunHeader } from '../../../../shared/types/agent-control.js';
import { AgentRunPaths } from '../../../agent-runs/agent-run-paths.js';
import { resolveWorkerInference } from '../../worker-inference.js';
import type { WorkerPreferencesDocument } from '../../../../shared/types/worker-preferences.js';
import { fakeAgentInference } from '../../../testing/fake-agent-inference.js';
import { SubagentModule } from '../subagent.module.js';
import { taskBoardService } from '../../../agent-runs/task-board-service.js';

const runtimeMock = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  destroyGates: new Map<string, Promise<void>>(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/piskie-test',
    getAppPath: () => '/tmp/piskie-test',
  },
}));

vi.mock('../../agent-runtime.js', () => ({
  AgentRuntime: class {
    readonly id: string;
    readonly spec: { assignment: 'question' | 'task-board' };
    approvalMode: 'auto' | 'confirm';

    constructor(config: {
      id: string;
      spec: { assignment: 'question' | 'task-board' };
      options?: { initialApprovalMode?: 'auto' | 'confirm'; [key: string]: unknown };
    }) {
      runtimeMock.configs.push(config as unknown as Record<string, unknown>);
      this.id = config.id;
      this.spec = config.spec;
      this.approvalMode = config.options?.initialApprovalMode ?? 'auto';
    }

    async start(): Promise<void> {}
    getEffectiveWorkspace(): string { return '/sample/worker-workspace'; }
    async destroy(): Promise<void> {
      await runtimeMock.destroyGates.get(this.id);
    }
    hasFailed(): boolean {
      return false;
    }
    setApprovalMode(mode: 'auto' | 'confirm'): void {
      this.approvalMode = mode;
    }
  },
}));

type WatchdogMeta = {
  onTerminal: 'grace' | 'immediate';
  graceMs: number;
  deadlineMs?: number;
  stalledAfterMs: number;
  stalledReported: boolean;
  closureCheckSent: boolean;
  startedAt: number;
  lastProgressAt: number;
  terminalAt?: number;
  terminalType?: string;
};

type TestableSubagentModule = {
  host: {
    id: string;
    mainAgentId: string;
    post: ReturnType<typeof vi.fn>;
    emitStateChange: ReturnType<typeof vi.fn>;
    getInference: () => ReturnType<typeof fakeAgentInference>;
  };
  subagents: Map<string, AgentEngine>;
  subagentMeta: Map<string, WatchdogMeta>;
  checkSubagentLifecycles: () => void;
  destroySubagentOrEscalate: ReturnType<typeof vi.fn>;
  sendEventToSubagent: (subagentId: string, event: Record<string, unknown>) => boolean;
};

function createModule() {
  const module = new SubagentModule() as unknown as TestableSubagentModule & SubagentModule;
  const post = vi.fn(() => true);
  module.host = {
    id: 'main-1',
    mainAgentId: 'main-1',
    post,
    emitStateChange: vi.fn(),
    getInference: () => fakeAgentInference(),
  };
  module.destroySubagentOrEscalate = vi.fn();
  return { module, post };
}

function createMeta(overrides: Partial<WatchdogMeta> = {}): WatchdogMeta {
  const now = Date.now();
  return {
    onTerminal: 'grace',
    graceMs: 5 * 60_000,
    deadlineMs: 2_000,
    stalledAfterMs: 1_000,
    stalledReported: false,
    closureCheckSent: false,
    startedAt: now - 10_000,
    lastProgressAt: now - 10_000,
    ...overrides,
  };
}

function createChild(overrides: Record<string, unknown> = {}): AgentEngine {
  return {
    id: 'child-1',
    spec: { assignment: 'task-board' },
    interrupted: false,
    post: vi.fn(() => true),
    // IdlePermit 由 runtime 从对话/后台租约派生；默认 inert 且无 permit。
    isPumping: false,
    getIdlePermits: () => [],
    ...overrides,
  } as unknown as AgentEngine;
}

function createHeaderStore(mainAgentId: string, entries: ConversationEntry[] = []) {
  let header: AgentRunHeader = {
    agentId: mainAgentId,
    agentSpec: 'director',
    modeId: 'normal',
    runConfig: { name: mainAgentId, description: '', promptTemplate: '' },
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    currentModel: 'provider::model',
    approvalMode: 'auto',
    childAgents: [],
  };
  const store = {
    paths: new AgentRunPaths('/tmp/piskie-test'),
    read: vi.fn(() => entries),
    readHeader: vi.fn(() => header),
    writeHeader: vi.fn((_mainAgentId: string, next: AgentRunHeader) => {
      header = next;
    }),
  };
  return { store, readHeader: () => header };
}

function allocateSequential(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function moduleConfig(prefix: string) {
  return {
    runConfig: { name: prefix, description: '', promptTemplate: '' },
    allocateAgentId: allocateSequential(prefix),
  };
}

beforeEach(() => {
  vi.spyOn(taskBoardService, 'createCompactSnapshot').mockImplementation(async (_main, ids) => ({
    taskSummary: 'Sample tasks',
    items: ids.map((id) => ({ id, subject: id, status: 'pending', owner: null, dependsOn: [], assignedHere: true })),
  }));
});
afterEach(() => vi.restoreAllMocks());

describe('SubagentModule resume boundaries', () => {
  it('reads preferences for each creation, preserves earlier selections and skips task-board work for Explore', async () => {
    const mainAgentId = `preferences-${Date.now()}`;
    const headerStore = createHeaderStore(mainAgentId);
    const module = new SubagentModule() as unknown as SubagentModule & { createSubagent: (config: SubagentConfig) => Promise<string> };
    const preferences: WorkerPreferencesDocument = { schemaVersion: 1, revision: 0, profiles: {} };
    const inference = fakeAgentInference();
    const host = { id: mainAgentId, mainAgentId, phase: 'running', spec: { name: 'director' },
      currentModel: 'parent::model', reasoningOverride: { kind: 'effort', effort: 'high' }, approvalMode: 'auto',
      getInference: () => inference, getConversationStore: () => headerStore.store,
      appendConversationEntry: vi.fn(), emitStateChange: vi.fn(),
    } as unknown as AgentHost;
    module.init(host, { ...moduleConfig('preference-worker'), resolveWorkerInference: async (input) => resolveWorkerInference(input, preferences, inference) });
    const before = runtimeMock.configs.length;
    try {
      const input: SubagentConfig = { type: 'explore', subject: 'Investigation', prompt: 'Inspect code' };
      await module.createSubagent(input);
      preferences.profiles.explore = { inference: { target: { providerId: 'custom', modelId: 'model' }, reasoning: { kind: 'effort', effort: 'low' } } };
      await module.createSubagent(input);
      expect(runtimeMock.configs[before]).toMatchObject({ options: { initialModel: 'parent::model', initialReasoning: { kind: 'effort', effort: 'high' } } });
      expect(runtimeMock.configs[before + 1]).toMatchObject({ options: { initialModel: 'custom::model', initialReasoning: { kind: 'effort', effort: 'low' } } });
      expect(taskBoardService.createCompactSnapshot).not.toHaveBeenCalled();
    } finally { await module.onDestroy(); }
  });

  it('propagates preference read errors before task-board snapshots, IDs or Runtime creation', async () => {
    const module = new SubagentModule() as unknown as SubagentModule & { createSubagent: (config: SubagentConfig) => Promise<string> };
    const allocateAgentId = vi.fn(() => 'never');
    module.init({ id: 'parent', mainAgentId: 'parent', phase: 'running', spec: { name: 'director' },
      currentModel: 'parent::model', reasoningOverride: { kind: 'disabled' },
    } as unknown as AgentHost, { ...moduleConfig('invalid'), allocateAgentId,
      resolveWorkerInference: async () => { throw new Error('Preferences could not be read'); },
    });
    const before = runtimeMock.configs.length;
    await expect(module.createSubagent({ type: 'local-worker', subject: 'Task', prompt: 'Inspect', taskIds: ['task'] })).rejects.toThrow('Preferences could not be read');
    expect(allocateAgentId).not.toHaveBeenCalled();
    expect(taskBoardService.createCompactSnapshot).not.toHaveBeenCalled();
    expect(runtimeMock.configs).toHaveLength(before);
  });

  it('revalidates the selected target after asynchronous creation preparation', async () => {
    const mainAgentId = `preference-wait-${Date.now()}`;
    const headerStore = createHeaderStore(mainAgentId);
    const module = new SubagentModule() as unknown as SubagentModule & { createSubagent: (config: SubagentConfig) => Promise<string> };
    let available = true;
    const inference = fakeAgentInference({ assertTarget: () => { if (!available) throw new Error('Model became unavailable'); } });
    const host = { id: mainAgentId, mainAgentId, phase: 'running', spec: { name: 'director' },
      currentModel: 'parent::model', reasoningOverride: { kind: 'disabled' },
      getInference: () => inference, getConversationStore: () => headerStore.store,
    } as unknown as AgentHost;
    module.init(host, { ...moduleConfig('preference-wait'), resolveWorkerInference: async (input) => resolveWorkerInference(input, { schemaVersion: 1, revision: 0, profiles: {} }, inference) });
    vi.mocked(taskBoardService.createCompactSnapshot).mockImplementationOnce(async () => {
      available = false;
      return { taskSummary: '', items: [] };
    });
    const before = runtimeMock.configs.length;
    await expect(module.createSubagent({ type: 'local-worker', subject: 'Task', prompt: 'Inspect', taskIds: ['task'] })).rejects.toThrow('Model became unavailable');
    expect(runtimeMock.configs).toHaveLength(before);
    expect(headerStore.readHeader().childAgents).toEqual([]);
  });

  it('rejects invalid reasoning before mutating the child', () => {
    const { module } = createModule();
    const child = createChild({ setReasoningOverride: vi.fn() });
    module.subagents.set('child-1', child);
    for (const tokens of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => module.applyChildReasoning('child-1', { kind: 'budget', tokens })).toThrow('positive integer');
    }
    module.host.getInference = () => fakeAgentInference({ resolveReasoning: () => { throw new Error('Unsupported effort'); } });
    expect(() => module.applyChildReasoning('child-1', { kind: 'effort', effort: 'max' })).toThrow('Unsupported effort');
    expect(child.setReasoningOverride).not.toHaveBeenCalled();
  });

  it('returns a created Worker only after its trace file exists', async () => {
    const mainAgentId = `main-trace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const module = new SubagentModule() as unknown as SubagentModule & {
      createSubagent: (
        config: SubagentConfig
      ) => Promise<string>;
    };
    const headerStore = createHeaderStore(mainAgentId);
    const host = {
      id: mainAgentId,
      mainAgentId,
      phase: 'running',
      spec: { name: 'director' },
      currentModel: 'provider::model',
      approvalMode: 'auto',
      getConversationStore: () => headerStore.store,
      appendConversationEntry: vi.fn(),
      emitStateChange: vi.fn(),
    } as unknown as AgentHost;
    module.init(host, moduleConfig('worker-trace'));

    try {
      const subagentId = await module.createSubagent(
        {
          type: 'local-worker',
          subject: 'trace initialization',
          taskIds: ['task-a'],
          prompt: 'Verify that the trace exists before creation returns.',
        }
      );
      const tracePath = module.getSubagentTraceFilePath(subagentId);

      expect(subagentId).toBe('worker-trace-1');
      expect(tracePath).toBe(
        headerStore.store.paths.tracePath({ agentId: mainAgentId, workerId: subagentId })
      );
      await expect(fs.readFile(tracePath!, 'utf-8')).resolves.toBe('');
      expect(headerStore.readHeader().childAgents).toMatchObject([
        {
          id: subagentId,
          config: { subject: 'trace initialization' },
        },
      ]);

      await module.stopSubagentById(subagentId, 'test_stop');
      expect(headerStore.readHeader().childAgents).toEqual([]);
    } finally {
      await module.onDestroy();
    }
  });

  it('allows one child to switch model and reasoning without changing its sibling', () => {
    const { module } = createModule();
    const first = createChild({ setModel: vi.fn(), setReasoningOverride: vi.fn() });
    const sibling = createChild({
      id: 'child-2',
      setModel: vi.fn(),
      setReasoningOverride: vi.fn(),
    });
    module.subagents.set('child-1', first);
    module.subagents.set('child-2', sibling);

    expect(module.applyChildModel('child-1', 'provider::model-b')).toBe(true);
    expect(module.applyChildReasoning('child-1', { kind: 'effort', effort: 'high' })).toBe(true);

    expect(first.setModel).toHaveBeenCalledWith('provider::model-b');
    expect(first.setReasoningOverride).toHaveBeenCalledWith({ kind: 'effort', effort: 'high' });
    expect(sibling.setModel).not.toHaveBeenCalled();
    expect(sibling.setReasoningOverride).not.toHaveBeenCalled();
  });

  it('new Workers inherit the parent model, reasoning and approval at creation', async () => {
    const mainAgentId = `main-approval-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const module = new SubagentModule() as unknown as SubagentModule & {
      createSubagent: (
        config: SubagentConfig
      ) => Promise<string>;
    };
    const parentMcpCapability = {
      projectContextId: 'project:/workspace',
      workspace: '/workspace',
      servers: [],
      blocked: [],
      warnings: [],
      fingerprint: 'parent-capability',
    };
    const headerStore = createHeaderStore(mainAgentId);
    const host = {
      id: mainAgentId,
      mainAgentId,
      phase: 'running',
      spec: { name: 'director' },
      currentModel: 'provider::model',
      reasoningOverride: { kind: 'effort', effort: 'medium' },
      approvalMode: 'auto' as 'auto' | 'confirm',
      getMcpCapabilitySnapshot: () => parentMcpCapability,
      getConversationStore: () => headerStore.store,
      appendConversationEntry: vi.fn(),
      emitStateChange: vi.fn(),
    } as unknown as AgentHost & { approvalMode: 'auto' | 'confirm' };
    module.init(host, moduleConfig('worker-approval'));

    try {
      const firstId = await module.createSubagent(
        {
          type: 'local-worker',
          subject: 'first',
          taskIds: ['task-a'],
          prompt: 'first',
          skills: ['skill-a'],
        }
      );
      const first = module.getSubagents().get(firstId)!;
      expect(first.approvalMode).toBe('auto');
      const firstConfig = runtimeMock.configs.at(-1) as {
        options: Record<string, unknown>;
      };
      expect(firstConfig.options).toMatchObject({
        initialModel: 'provider::model', initialReasoning: { kind: 'effort', effort: 'medium' },
      });
      expect(firstConfig.options.parentMcpCapability).toBe(parentMcpCapability);
      expect(firstConfig.options).not.toHaveProperty('mcpSession');

      host.approvalMode = 'confirm';
      Object.assign(host, { currentModel: 'provider::model-next', reasoningOverride: { kind: 'effort', effort: 'high' } });
      const secondId = await module.createSubagent(
        {
          type: 'local-worker',
          subject: 'second',
          taskIds: ['task-b'],
          prompt: 'second',
          skills: ['skill-b-automation'],
        }
      );

      expect(firstId).toBe('worker-approval-1');
      expect(secondId).toBe('worker-approval-2');
      expect(module.getSubagents().get(secondId)?.approvalMode).toBe('confirm');
      const secondConfig = runtimeMock.configs.at(-1) as { options: Record<string, unknown> };
      expect(secondConfig.options).toMatchObject({
        initialModel: 'provider::model-next', initialReasoning: { kind: 'effort', effort: 'high' },
      });
      expect(firstConfig.options.initialReasoning).toEqual({ kind: 'effort', effort: 'medium' });
      expect(first.approvalMode).toBe('auto');
    } finally {
      await module.onDestroy();
    }
  });

  it('rejects non-Worker specs at the Module boundary', async () => {
    const runtimeCount = runtimeMock.configs.length;
    const module = new SubagentModule() as unknown as {
      host: AgentHost;
      createSubagent: (
        config: SubagentConfig
      ) => Promise<string>;
    };
    module.host = {
      id: 'main-1',
      mainAgentId: 'main-1',
      phase: 'running',
      spec: { name: 'director' },
    } as unknown as AgentHost;

    await expect(
      module.createSubagent(
        {
          type: 'director',
          subject: 'invalid child',
          taskIds: ['task-a'],
          prompt: 'This must be rejected before runtime creation.',
        }
      )
    ).rejects.toThrow("AgentSpec 'director' is not a Worker");
    expect(runtimeMock.configs).toHaveLength(runtimeCount);
  });

  it('keeps specialized Worker IDs unique while serially handing off one Director browser binding', async () => {
    const directorId = 'a1b2c3d4';
    const module = new SubagentModule() as unknown as SubagentModule & {
      createSubagent(
        config: SubagentConfig
      ): Promise<string>;
    };
    const headerStore = createHeaderStore(directorId);
    const host = {
      id: directorId,
      mainAgentId: directorId,
      phase: 'running',
      spec: { name: 'browser-skill-director' },
      currentModel: 'provider::model',
      approvalMode: 'auto',
      getConversationStore: () => headerStore.store,
      appendConversationEntry: vi.fn(),
      emitStateChange: vi.fn(),
    } as unknown as AgentHost;
    module.init(host, moduleConfig('shared-worker'));

    try {
      const scoutId = await module.createSubagent(
        {
          type: 'site-scout',
          subject: 'scout',
          taskIds: ['task-scout'],
          prompt: 'scout',
        }
      );
      const scoutConfig = runtimeMock.configs.at(-1) as { options: Record<string, unknown> };
      const sessionBinding = {
        browserId: directorId,
        userDataId: directorId,
      };
      expect(scoutId).toBe('shared-worker-1');
      expect(scoutConfig.options.browserBinding).toEqual(sessionBinding);

      let releaseDestroy!: () => void;
      const destroyGate = new Promise<void>((resolve) => {
        releaseDestroy = resolve;
      });
      runtimeMock.destroyGates.set(scoutId, destroyGate);
      const stop = module.stopSubagentById(scoutId);
      const builder = module.createSubagent(
        {
          type: 'browser-skill-builder',
          subject: 'builder',
          taskIds: ['task-builder'],
          prompt: 'builder',
        }
      );

      await Promise.resolve();
      expect(runtimeMock.configs.at(-1)).toBe(scoutConfig);
      releaseDestroy();
      await stop;
      const builderId = await builder;
      const builderConfig = runtimeMock.configs.at(-1) as { options: Record<string, unknown> };
      expect(builderId).toBe('shared-worker-2');
      expect(builderConfig.options.browserBinding).toEqual(sessionBinding);
    } finally {
      runtimeMock.destroyGates.clear();
      await module.onDestroy();
    }
  });

  it('does not construct the next shared-Profile Worker when the previous teardown fails', async () => {
    const directorId = 'b1c2d3e4';
    const module = new SubagentModule() as unknown as SubagentModule & {
      createSubagent(
        config: SubagentConfig
      ): Promise<string>;
    };
    const headerStore = createHeaderStore(directorId);
    const host = {
      id: directorId,
      mainAgentId: directorId,
      phase: 'running',
      spec: { name: 'browser-skill-director' },
      currentModel: 'provider::model',
      approvalMode: 'auto',
      getConversationStore: () => headerStore.store,
      appendConversationEntry: vi.fn(),
      emitStateChange: vi.fn(),
    } as unknown as AgentHost;
    module.init(host, moduleConfig('failed-handoff-worker'));

    const scoutId = await module.createSubagent(
      {
        type: 'site-scout',
        subject: 'scout',
        taskIds: ['task-scout'],
        prompt: 'scout',
      }
    );
    const runtimeCount = runtimeMock.configs.length;
    const teardownError = new Error('Chromium did not terminate');
    let rejectDestroy!: (error: Error) => void;
    runtimeMock.destroyGates.set(
      scoutId,
      new Promise<void>((_resolve, reject) => {
        rejectDestroy = reject;
      })
    );

    const stopped = module.stopSubagentById(scoutId).catch((error) => error);
    const builder = module.createSubagent(
      {
        type: 'browser-skill-builder',
        subject: 'builder',
        taskIds: ['task-builder'],
        prompt: 'builder',
      }
    );
    await Promise.resolve();
    expect(runtimeMock.configs).toHaveLength(runtimeCount);

    rejectDestroy(teardownError);
    await expect(builder).rejects.toBe(teardownError);
    expect(await stopped).toBe(teardownError);
    expect(runtimeMock.configs).toHaveLength(runtimeCount);

    await expect(module.onDestroy()).rejects.toThrow('子代理销毁失败');
    runtimeMock.destroyGates.clear();
  });

  it('releases unfinished task ownership when the Main tears down active Workers', async () => {
    const mainAgentId = `main-release-${Date.now()}-${Math.random()}`;
    await taskBoardService.syncTaskBoard({
      mainAgentId,
      callerAgentId: mainAgentId,
      taskSummary: 'Release board',
      activeWorkerIds: ['worker-release'],
      items: [
        {
          id: 'task-open',
          subject: 'Open task',
          description: 'Must return to the unassigned pool.',
          status: 'in_progress',
          owner: 'worker-release',
          dependsOn: [],
        },
      ],
    });

    const module = new SubagentModule();
    const headerStore = createHeaderStore(mainAgentId);
    const interruptedChild: AgentRunHeader['childAgents'][number] = {
      id: 'worker-release',
      config: {
        type: 'local-worker',
        subject: 'Open task',
        taskIds: ['task-open'],
        prompt: 'Finish the open task.',
      },
      createdAt: Date.now(),
    };
    headerStore.store.writeHeader(mainAgentId, {
      ...headerStore.readHeader(),
      childAgents: [interruptedChild],
    });
    headerStore.store.writeHeader.mockClear();
    const host = {
      id: mainAgentId,
      mainAgentId,
      getConversationStore: () => headerStore.store,
    } as unknown as AgentHost;
    module.init(host, {});
    module.getSubagents().set('worker-release', {
      spec: { assignment: 'task-board' },
      destroy: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentEngine);

    await module.onDestroy();

    expect(await taskBoardService.readTaskBoard(mainAgentId)).toMatchObject({
      items: [{ id: 'task-open', owner: null, status: 'pending' }],
    });
    expect(headerStore.store.writeHeader).not.toHaveBeenCalled();
    expect(headerStore.readHeader().childAgents).toEqual([interruptedChild]);
  });
});

describe('SubagentModule watchdog interrupt semantics', () => {
  it('中断子代理跳过 stalled 和 deadline，不上报也不销毁', () => {
    const { module, post } = createModule();
    const meta = createMeta();
    module.subagents.set('child-1', createChild({ interrupted: true }));
    module.subagentMeta.set('child-1', meta);

    module.checkSubagentLifecycles();

    expect(post).not.toHaveBeenCalled();
    expect(module.destroySubagentOrEscalate).not.toHaveBeenCalled();
    expect(meta.stalledReported).toBe(false);
  });

  it('终态宽限期优先于 interrupted，过期后仍静默回收', () => {
    const { module, post } = createModule();
    const meta = createMeta({
      terminalAt: Date.now() - 2_000,
      terminalType: 'completed',
      graceMs: 100,
    });
    module.subagents.set('child-1', createChild({ interrupted: true }));
    module.subagentMeta.set('child-1', meta);

    module.checkSubagentLifecycles();

    expect(post).not.toHaveBeenCalled();
    expect(module.destroySubagentOrEscalate).toHaveBeenCalledWith('child-1', 'completed');
  });

  it('成功投递真实输入复用既有 watchdog 元数据并重置计时基线', () => {
    const { module, post: parentPost } = createModule();
    const child = createChild();
    const post = vi.mocked(child.post);
    const meta = createMeta({
      deadlineMs: undefined,
      lastProgressAt: 1,
      stalledReported: true,
      closureCheckSent: true,
      terminalAt: 2,
      terminalType: 'completed',
    });
    module.subagents.set('child-1', child);
    module.subagentMeta.set('child-1', meta);
    const before = Date.now();

    const delivered = module.injectEventToSubagent('child-1', {
      id: 'event-1',
      timestamp: new Date(),
      source: 'parent',
      content: 'continue',
    } as AgentInputEvent);

    expect(delivered).toBe(true);
    expect(post).toHaveBeenCalledOnce();
    expect(meta.lastProgressAt).toBeGreaterThanOrEqual(before);
    expect(meta.stalledReported).toBe(false);
    expect(meta.closureCheckSent).toBe(false);
    expect(meta.terminalAt).toBeUndefined();
    expect(meta.terminalType).toBeUndefined();

    module.checkSubagentLifecycles();
    expect(parentPost).not.toHaveBeenCalled();

    meta.lastProgressAt = Date.now() - meta.stalledAfterMs - 1;
    module.checkSubagentLifecycles();
    expect(parentPost).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0]).toMatchObject({
      source: 'system',
      content: expect.stringContaining('<closure_check>'),
    });
    expect(meta.closureCheckSent).toBe(true);

    meta.lastProgressAt = Date.now() - meta.stalledAfterMs - 1;
    module.checkSubagentLifecycles();
    expect(parentPost).toHaveBeenCalledOnce();
    expect((parentPost.mock.calls[0][0] as AgentInputEvent).content).toMatchObject({
      type: 'stalled',
    });
  });

  it('父流程 send_event 成功投递走同一 watchdog 基线重置', () => {
    const { module } = createModule();
    const child = createChild();
    const post = vi.mocked(child.post);
    const meta = createMeta({
      lastProgressAt: 1,
      stalledReported: true,
      closureCheckSent: true,
    });
    module.subagents.set('child-1', child);
    module.subagentMeta.set('child-1', meta);
    const before = Date.now();
    const envelope = {
      storage: 'inline',
      type: 'message',
      data: { type: 'message', message: 'continue' },
      originalSize: 8,
    } satisfies ATAEventEnvelope;

    const delivered = module.sendEventToSubagent(
      'child-1',
      envelope as unknown as Record<string, unknown>
    );

    expect(delivered).toBe(true);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'parent',
        content: envelope,
      })
    );
    expect(meta.lastProgressAt).toBeGreaterThanOrEqual(before);
    expect(meta.stalledReported).toBe(false);
    expect(meta.closureCheckSent).toBe(false);
  });

  it('isPumping 在途（生图审核/长工具）超过 stalled 与 deadline 门限：不上报、不销毁、复位 stalledReported', () => {
    const { module, post } = createModule();
    const meta = createMeta({
      lastProgressAt: Date.now() - 20 * 60_000, // 超过 10 分钟量级的静默
      stalledReported: true,
      deadlineMs: 2_000,
    });
    const child = createChild({ isPumping: true });
    module.subagents.set('child-1', child);
    module.subagentMeta.set('child-1', meta);

    module.checkSubagentLifecycles();

    expect(post).not.toHaveBeenCalled();
    expect(child.post).not.toHaveBeenCalled();
    expect(module.destroySubagentOrEscalate).not.toHaveBeenCalled();
    expect(meta.stalledReported).toBe(false);
  });

  it('三个派生 IdlePermit 都避开 stalled 与 deadline', () => {
    const permits = [
      { kind: 'user_input', callId: 'ask-1' },
      { kind: 'user_action', callId: 'event-1' },
      { kind: 'background_job', taskId: 'task-1' },
    ];
    for (const permit of permits) {
      const { module, post } = createModule();
      const meta = createMeta({ lastProgressAt: Date.now() - 20 * 60_000, stalledReported: true });
      const child = createChild({ getIdlePermits: () => [permit] });
      module.subagents.set('child-1', child);
      module.subagentMeta.set('child-1', meta);

      module.checkSubagentLifecycles();

      expect(post).not.toHaveBeenCalled();
      expect(child.post).not.toHaveBeenCalled();
      expect(module.destroySubagentOrEscalate).not.toHaveBeenCalled();
      expect(meta.stalledReported).toBe(false);
    }
  });

  it('真正 idle 首次先请求收尾确认，再次超时才 stalled 上报并回收', () => {
    const { module, post } = createModule();
    const child = createChild();
    const meta = createMeta({
      lastProgressAt: Date.now() - 10_000, // 超过 stalledAfterMs(1s) 与 deadlineMs(2s)
    });
    module.subagents.set('child-1', child);
    module.subagentMeta.set('child-1', meta);

    module.checkSubagentLifecycles();

    expect(child.post).toHaveBeenCalledWith({
      source: 'system',
      content: expect.stringContaining('<closure_check>'),
    });
    expect(meta.closureCheckSent).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(module.destroySubagentOrEscalate).not.toHaveBeenCalled();

    meta.lastProgressAt = Date.now() - 10_000;
    module.checkSubagentLifecycles();

    // stalled 上报 + watchdog failed 事件（deadline）都经 host.post
    const types = post.mock.calls.map(
      (c) => (c[0] as AgentInputEvent).content as Record<string, unknown>
    );
    expect(types.some((c) => c.type === 'stalled')).toBe(true);
    expect(
      types.some(
        (c) =>
          c.type === 'failed' && (c.data as Record<string, unknown>)?.reason === 'watchdog_timeout'
      )
    ).toBe(true);
    expect(module.destroySubagentOrEscalate).toHaveBeenCalledWith('child-1', 'timeout');
  });

  it('投递失败时不改 watchdog 元数据', () => {
    const { module } = createModule();
    const meta = createMeta({
      lastProgressAt: 1,
      stalledReported: true,
      closureCheckSent: true,
    });
    module.subagents.set('child-1', createChild({ post: vi.fn(() => false) }));
    module.subagentMeta.set('child-1', meta);

    const delivered = module.injectEventToSubagent('child-1', {
      id: 'event-1',
      timestamp: new Date(),
      source: 'parent',
      content: 'continue',
    } as AgentInputEvent);

    expect(delivered).toBe(false);
    expect(meta.lastProgressAt).toBe(1);
    expect(meta.stalledReported).toBe(true);
    expect(meta.closureCheckSent).toBe(true);
  });

  it('收尾确认投递失败时直接执行已到期的 watchdog 处置', () => {
    const { module, post } = createModule();
    const child = createChild({ post: vi.fn(() => false) });
    const meta = createMeta({ lastProgressAt: Date.now() - 10_000 });
    module.subagents.set('child-1', child);
    module.subagentMeta.set('child-1', meta);

    module.checkSubagentLifecycles();

    expect(child.post).toHaveBeenCalledOnce();
    expect(meta.closureCheckSent).toBe(false);
    const types = post.mock.calls.map(
      (call) => (call[0] as AgentInputEvent).content as Record<string, unknown>
    );
    expect(types.some((content) => content.type === 'stalled')).toBe(true);
    expect(
      types.some(
        (content) =>
          content.type === 'failed' &&
          (content.data as Record<string, unknown>)?.reason === 'watchdog_timeout'
      )
    ).toBe(true);
    expect(module.destroySubagentOrEscalate).toHaveBeenCalledWith('child-1', 'timeout');
  });
});
