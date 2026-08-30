import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import type { AgentEngine } from '../../agent-engine.js';
import type { AgentHost } from '../../agent-host.js';
import type {
  AssignmentTaskBoardSnapshot,
  AgentInputEvent,
  ConversationEntry,
  SubagentConfig,
} from '../../../../shared/types/index.js';
import type { ATAEventEnvelope } from '../../ata/ata-event-envelope.js';
import type { AgentRunHeader } from '../../../../shared/types/agent-control.js';
import { AgentRunPaths } from '../../../agent-runs/agent-run-paths.js';
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
    approvalMode: 'auto' | 'confirm';

    constructor(config: {
      id: string;
      options?: { initialApprovalMode?: 'auto' | 'confirm'; [key: string]: unknown };
    }) {
      runtimeMock.configs.push(config as unknown as Record<string, unknown>);
      this.id = config.id;
      this.approvalMode = config.options?.initialApprovalMode ?? 'auto';
    }

    async start(): Promise<void> {}
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
    getInference: () => { assertTarget: ReturnType<typeof vi.fn> };
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
    getInference: () => ({ assertTarget: vi.fn() }),
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

describe('SubagentModule resume boundaries', () => {
  it('未知类型错误列出当前 Director 实际可用的专属 Worker', () => {
    const module = new SubagentModule() as unknown as SubagentModule & {
      host: AgentHost;
      resolveWorkerType(type: string): { error?: string };
    };
    module.host = {
      id: 'browser-skill-main',
      mainAgentId: 'browser-skill-main',
      spec: { name: 'browser-skill-director' },
    } as unknown as AgentHost;

    expect(module.resolveWorkerType('browser-skill-scout').error).toBe(
      '未知的子流程类型: browser-skill-scout。当前可用 type: browser / local / browser-skill-builder / browser-skill-verifier / site-scout'
    );
    expect(module.resolveWorkerType('browser-worker').error).toContain(
      '当前可用 type: browser / local'
    );
    expect(module.resolveWorkerType('site-scout')).toEqual({
      mode: 'browser',
      agentSpec: 'site-scout',
    });
  });

  it('returns a created Worker only after its trace file exists', async () => {
    const mainAgentId = `main-trace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const module = new SubagentModule() as unknown as SubagentModule & {
      createSubagent: (
        config: SubagentConfig,
        snapshot: AssignmentTaskBoardSnapshot
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
          mode: 'local',
          subject: 'trace initialization',
          taskIds: ['task-a'],
          prompt: 'Verify that the trace exists before creation returns.',
        },
        {
          taskSummary: 'trace test',
          items: [],
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

  it('新 Worker 继承 Main 当前模式，创建完成后不随 Main 批量变化', async () => {
    const mainAgentId = `main-approval-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const module = new SubagentModule() as unknown as SubagentModule & {
      createSubagent: (
        config: SubagentConfig,
        snapshot: AssignmentTaskBoardSnapshot
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
      approvalMode: 'auto' as 'auto' | 'confirm',
      getMcpCapabilitySnapshot: () => parentMcpCapability,
      getConversationStore: () => headerStore.store,
      appendConversationEntry: vi.fn(),
      emitStateChange: vi.fn(),
    } as unknown as AgentHost & { approvalMode: 'auto' | 'confirm' };
    module.init(host, moduleConfig('worker-approval'));
    const snapshot = { taskSummary: 'inheritance', items: [] };

    try {
      const firstId = await module.createSubagent(
        {
          mode: 'local',
          subject: 'first',
          taskIds: ['task-a'],
          prompt: 'first',
          skills: ['skill-a'],
        },
        snapshot
      );
      const first = module.getSubagents().get(firstId)!;
      expect(first.approvalMode).toBe('auto');
      const firstConfig = runtimeMock.configs.at(-1) as {
        options: Record<string, unknown>;
      };
      expect(firstConfig.options.parentMcpCapability).toBe(parentMcpCapability);
      expect(firstConfig.options).not.toHaveProperty('mcpSession');

      host.approvalMode = 'confirm';
      const secondId = await module.createSubagent(
        {
          mode: 'local',
          subject: 'second',
          taskIds: ['task-b'],
          prompt: 'second',
          skills: ['skill-b-automation'],
        },
        snapshot
      );

      expect(firstId).toBe('worker-approval-1');
      expect(secondId).toBe('worker-approval-2');
      expect(module.getSubagents().get(secondId)?.approvalMode).toBe('confirm');
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
        config: SubagentConfig,
        snapshot: AssignmentTaskBoardSnapshot
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
          mode: 'local',
          agentSpec: 'director',
          subject: 'invalid child',
          taskIds: ['task-a'],
          prompt: 'This must be rejected before runtime creation.',
        },
        {
          taskSummary: 'test board',
          items: [],
        }
      )
    ).rejects.toThrow("AgentSpec 'director' is not a Worker");
    expect(runtimeMock.configs).toHaveLength(runtimeCount);
  });

  it('keeps specialized Worker IDs unique while serially handing off one Director browser binding', async () => {
    const directorId = 'a1b2c3d4';
    const module = new SubagentModule() as unknown as SubagentModule & {
      createSubagent(
        config: SubagentConfig,
        snapshot: AssignmentTaskBoardSnapshot
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
    const snapshot = { taskSummary: 'handoff', items: [] };

    try {
      const scoutId = await module.createSubagent(
        {
          mode: 'browser',
          agentSpec: 'site-scout',
          subject: 'scout',
          taskIds: ['task-scout'],
          prompt: 'scout',
        },
        snapshot
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
          mode: 'browser',
          agentSpec: 'browser-skill-builder',
          subject: 'builder',
          taskIds: ['task-builder'],
          prompt: 'builder',
        },
        snapshot
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
        config: SubagentConfig,
        snapshot: AssignmentTaskBoardSnapshot
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
    const snapshot = { taskSummary: 'failed handoff', items: [] };

    const scoutId = await module.createSubagent(
      {
        mode: 'browser',
        agentSpec: 'site-scout',
        subject: 'scout',
        taskIds: ['task-scout'],
        prompt: 'scout',
      },
      snapshot
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
        mode: 'browser',
        agentSpec: 'browser-skill-builder',
        subject: 'builder',
        taskIds: ['task-builder'],
        prompt: 'builder',
      },
      snapshot
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
        mode: 'local',
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
