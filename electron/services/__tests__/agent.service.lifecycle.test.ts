import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunHeader, ConversationEntry } from '../../../shared/types/agent-control.js';
import { createAgentController } from '../../capabilities/agents/agent-controller.js';
import type { ControllerContext } from '../../capabilities/catalog.js';
import { createElectronPiskieClient } from '../../transport/electron/piskie-client.js';
import type { ElectronPreloadClient } from '../../transport/electron/preload-client.js';
import type { InferenceSelections, ModelTarget } from '../../../shared/types/inference.js';

const h = vi.hoisted(() => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  }

  const instances: FakeRuntime[] = [];
  const nextRuntimeTweaks: Array<(runtime: FakeRuntime) => void> = [];

  class FakeRuntime {
    readonly id: string;
    readonly mainAgentId: string;
    readonly config: any;
    prepareCalls = 0;
    startCalls = 0;
    destroyCalls = 0;
    prepareError: unknown;
    startError: unknown;
    stateError: unknown;
    destroyError: unknown;
    destroyGate?: Promise<void>;
    prepareGate?: Promise<void>;
    currentModel: string;
    postedModels: string[] = [];
    interruptGate?: Promise<void>;
    posted: unknown[] = [];
    durableUserMessages: Array<{ text: string; tag?: string; messageId?: string }> = [];
    replayedEntries: unknown[] = [];
    headerChildren: unknown[] = [];
    subagentModule?: {
      getSubagent(id: string): unknown;
      stopSubagentById(id: string, reason?: string): Promise<void>;
    };

    constructor(config: any) {
      this.config = config;
      this.id = config.id;
      this.mainAgentId = config.options.mainAgentId;
      this.currentModel = config.options.initialModel;
      instances.push(this);
      nextRuntimeTweaks.shift()?.(this);
    }

    async prepare(): Promise<void> {
      this.prepareCalls += 1;
      if (this.prepareError) throw this.prepareError;
      await this.prepareGate;
    }

    async start(): Promise<void> {
      this.startCalls += 1;
      if (this.startError) throw this.startError;
    }

    destroy(): Promise<void> {
      this.destroyCalls += 1;
      if (this.destroyGate) return this.destroyGate;
      return this.destroyError ? Promise.reject(this.destroyError) : Promise.resolve();
    }

    instantInterrupt(): Promise<void> {
      return this.interruptGate ?? Promise.resolve();
    }

    instantInterruptSubagent(): Promise<boolean> {
      return Promise.resolve(true);
    }

    post(event: unknown): boolean {
      if (this.destroyCalls > 0) return false;
      this.posted.push(event);
      this.postedModels.push(this.currentModel);
      return true;
    }

    setModel(model: string): void { this.currentModel = model; }
    injectEventToSubagent(): boolean { return true; }
    async replayConversation(entries: unknown[]): Promise<void> { this.replayedEntries = entries; }
    repairConversationTail(): void {}
    addDurableUserMessage(text: string, tag?: string, messageId?: string): void {
      this.durableUserMessages.push({ text, tag, messageId });
    }
    listChildAgents(): unknown[] { return []; }

    getModule(name: string) {
      return name === 'subagent' ? this.subagentModule : undefined;
    }

    buildHeader() {
      return {
        agentId: this.id,
        agentSpec: this.config.spec.name,
        modeId: this.config.options.initialModeId ?? 'normal',
        runConfig: structuredClone(this.config.options.runConfig),
        createdAt: '2026-08-19T00:00:00.000Z',
        lastActiveAt: '2026-08-19T00:00:00.000Z',
        currentModel: this.currentModel,
        approvalMode: this.config.options.initialApprovalMode ?? 'confirm',
        childAgents: structuredClone(this.headerChildren),
      };
    }

    getControlState() {
      if (this.stateError) throw this.stateError;
      return {
        agentId: this.id,
        phase: 'waiting',
        interrupted: false,
        currentModel: this.currentModel,
        reasoningOverride: { kind: 'provider-default' },
        approvalMode: this.config.options.initialApprovalMode ?? 'confirm',
        modeId: this.config.options.initialModeId ?? 'normal',
        conversationLength: 0,
        children: [],
        agentSpec: this.config.spec.name,
        runConfig: structuredClone(this.config.options.runConfig),
        createdAt: '2026-08-19T00:00:00.000Z',
        runMetrics: {},
      };
    }
  }

  class FakeStore {
    headers = new Map<string, any>();
    entries = new Map<string, unknown[]>();
    workers = new Map<string, string[]>();
    constructor(_root?: string) {}
    subscribeAppends(): () => void { return () => undefined; }
    absolutizeImageRefs(_mainAgentId: string, _agentId: string, entry: unknown) { return entry; }
    writeHeader(mainAgentId: string, value: any): void {
      this.headers.set(mainAgentId, structuredClone(value));
    }
    readHeader(mainAgentId: string) {
      const value = this.headers.get(mainAgentId);
      return value ? structuredClone(value) : null;
    }
    scanHeaders() { return structuredClone([...this.headers.values()]); }
    findMainAgentId(agentId: string): string | null {
      if (this.headers.has(agentId)) return agentId;
      for (const [mainAgentId, workerIds] of this.workers) {
        if (workerIds.includes(agentId)) return mainAgentId;
      }
      return null;
    }
    hasAgentId(agentId: string): boolean { return this.findMainAgentId(agentId) !== null; }
    read(mainAgentId: string, agentId: string): unknown[] {
      return structuredClone(this.entries.get(`${mainAgentId}/${agentId}`) ?? []);
    }
    append(mainAgentId: string, agentId: string, entry: unknown): number {
      const key = `${mainAgentId}/${agentId}`;
      const values = this.entries.get(key) ?? [];
      values.push(structuredClone(entry));
      this.entries.set(key, values);
      return values.length - 1;
    }
    count(mainAgentId: string, agentId: string): number {
      return this.entries.get(`${mainAgentId}/${agentId}`)?.length ?? 0;
    }
    listWorkerIds(mainAgentId: string): string[] {
      return [...(this.workers.get(mainAgentId) ?? [])];
    }
    deleteAgentRun(mainAgentId: string): void {
      this.headers.delete(mainAgentId);
      this.workers.delete(mainAgentId);
      for (const key of this.entries.keys()) {
        if (key.startsWith(`${mainAgentId}/`)) this.entries.delete(key);
      }
    }
  }

  const browserDelete = vi.fn(async (_agentId: string) => undefined);
  const incidentStore = { raise: vi.fn(), clearAgent: vi.fn(), clearAll: vi.fn() };
  const releaseAllOwnedBy = vi.fn(() => 0);

  class FakeInferenceRuntimeHost {
    aiGateway = {};
    imageGateway = {};
    artifacts = {};
    configHost = { show: vi.fn(async () => ({ schemaVersion: 1, revision: 0, profiles: {} })) };
    control = { runtime: { capture: () => ({ configRevision: 1 }) } };
    selections = {
      read: async (): Promise<InferenceSelections> => ({
        schemaVersion: 1,
        revision: 1,
        ai: { providerId: 'provider-1', modelId: 'model-1' },
        image: { providerId: 'image-provider', modelId: 'image-model' },
      }),
    };
    readEffectiveSelections() { return this.selections.read(); }
    async initialize(): Promise<void> {}
    async close(): Promise<void> {}
  }

  class FakeAgentInference {
    assertTarget(_target: ModelTarget): void {}
    resolveReasoning(_target: unknown, selection: unknown) { return { selection }; }
    contextWindow(): number { return 200_000; }
  }

  class FakeImageApplication {
    hasTarget(): boolean { return true; }
  }

  return {
    FakeRuntime,
    FakeStore,
    instances,
    nextRuntimeTweaks,
    browserDelete,
    incidentStore,
    releaseAllOwnedBy,
    deferred,
    FakeInferenceRuntimeHost,
    FakeAgentInference,
    FakeImageApplication,
    reset() {
      instances.length = 0;
      nextRuntimeTweaks.length = 0;
      browserDelete.mockReset().mockResolvedValue(undefined);
      incidentStore.raise.mockClear();
      incidentStore.clearAgent.mockClear();
      incidentStore.clearAll.mockClear();
      releaseAllOwnedBy.mockClear();
    },
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/agent-service-lifecycle-test', on: () => undefined },
}));
vi.mock('../../agent/agent-runtime.js', () => ({ AgentRuntime: h.FakeRuntime }));
vi.mock('../../agent/agent-engine.js', () => ({ AgentEngine: class {} }));
vi.mock('../../agent/specs/index.js', () => {
  const spec = { name: 'director', role: 'director' };
  return {
    specRegistry: { get: (name: string) => name === 'director' ? spec : undefined },
  };
});
vi.mock('../../agent-runs/conversation-store.js', () => ({ ConversationStore: h.FakeStore }));
vi.mock('../../core/pilot/index.js', () => ({
  agentPilotPorts: { skills: {}, browser: {} },
  browserControlPort: { deleteUserDataById: h.browserDelete },
  pilotRuntimeHost: { initialize: async () => undefined, stop: async () => undefined },
}));
vi.mock('../../inference/composition/runtime-host.js', () => ({
  InferenceRuntimeHost: h.FakeInferenceRuntimeHost,
}));
vi.mock('../../inference/application/agent-inference-port.js', () => ({
  DefaultAgentInferencePort: h.FakeAgentInference,
}));
vi.mock('../../inference/application/image-application-port.js', () => ({
  DefaultImageApplicationPort: h.FakeImageApplication,
}));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: h.incidentStore,
}));
vi.mock('../../agent-runs/task-board-service.js', () => ({
  taskBoardService: { readTaskBoard: vi.fn(async () => null) },
}));
vi.mock('../../agent-runs/agent-run-trace-service.js', () => ({
  agentRunTraceService: {
    attach: vi.fn(async () => ({ contentProduced: vi.fn() })),
    detach: vi.fn(async () => undefined),
    recordLifecycle: vi.fn(),
  },
}));
vi.mock('../../core/occupancy/index.js', () => ({
  occupancyRegistry: {
    clear: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    claim: vi.fn(() => ({ ok: true })),
    releaseAllOwnedBy: h.releaseAllOwnedBy,
    find: vi.fn(() => undefined),
    list: () => [],
  },
}));

import { directorSpec } from '../../agent/specs/builtin/director.js';
import { agentRunTraceService } from '../../agent-runs/agent-run-trace-service.js';
import { taskBoardService } from '../../agent-runs/task-board-service.js';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentService } from '../agent.service.js';
import { MessagingAgentSession } from '../../im-gateway/messaging-agent-session.js';

const service = agentService as any;
const releases: Array<{ agentId: string; reason: string }> = [];
const outputs: Array<{ agentId: string; content?: string }> = [];
agentService.observations.runtimeReleases.subscribe((event) => releases.push(event));
agentService.observations.outputs.subscribe((event) => outputs.push(event));

beforeAll(async () => {
  const bindings = {
    userDataDirectory: '/tmp/agent-service-lifecycle-test',
    inferenceHost: new h.FakeInferenceRuntimeHost(),
    agentInference: new h.FakeAgentInference(),
    imageApplication: new h.FakeImageApplication(),
  } as unknown as Parameters<typeof agentService.initializeApplication>[0];
  await agentService.initializeApplication(bindings);
});

beforeEach(() => {
  h.reset();
  service.activeRuntimes.clear();
  service.failedTeardowns.clear();
  service.reservedAgentIds.clear();
  service.locks.clear();
  service.conversationStore = new h.FakeStore();
  service.createAgentCandidate = () => 'main-run';
  releases.length = 0;
  outputs.length = 0;
  vi.mocked(agentRunTraceService.attach).mockClear();
  vi.mocked(agentRunTraceService.detach).mockClear();
  vi.mocked(agentRunTraceService.recordLifecycle).mockClear();
});

describe('AgentService AgentRun 生命周期串行化', () => {
  it('injects live Worker preference resolution for both start and resume', async () => {
    await agentService.startAgent(launch());
    const first = h.instances[0]!;
    const input = { type: 'explore', parentModel: 'parent::actual', parentReasoning: { kind: 'effort', effort: 'high' } };
    await expect(first.config.options.resolveWorkerInference(input)).resolves.toEqual({ model: input.parentModel, reasoning: input.parentReasoning });
    await agentService.stopAgent(first.id);
    await agentService.resumeAgent(first.id);
    const resumed = h.instances.at(-1)!;
    expect(resumed).not.toBe(first);
    await expect(resumed.config.options.resolveWorkerInference(input)).resolves.toEqual({ model: input.parentModel, reasoning: input.parentReasoning });
  });

  it('stop 只在 destroy settle 后摘牌并发布 release', async () => {
    await agentService.startAgent(launch());
    const runtime = h.instances[0]!;
    service.conversationStore.append(runtime.id, runtime.id, { t: 'message', content: 'kept' });
    service.conversationStore.workers.set(runtime.id, ['worker-kept']);
    const gate = h.deferred();
    runtime.destroyGate = gate.promise;

    const stopping = agentService.stopAgent(runtime.id);
    await waitUntil(() => runtime.destroyCalls === 1);

    expect(agentService.hasAgentInMemory(runtime.id)).toBe(true);
    expect(releases).toEqual([]);

    gate.resolve();
    await stopping;

    expect(agentService.hasAgentInMemory(runtime.id)).toBe(false);
    expect(h.incidentStore.clearAgent).toHaveBeenCalledWith(runtime.id);
    expect(releases).toEqual([{ agentId: runtime.id, reason: 'stopped' }]);
    expect(service.conversationStore.readHeader(runtime.id)).toMatchObject({ agentId: runtime.id });
    expect(service.conversationStore.read(runtime.id, runtime.id)).toEqual([
      { t: 'message', content: 'kept' },
    ]);
    expect(service.conversationStore.listWorkerIds(runtime.id)).toEqual(['worker-kept']);
  });

  it('stop 挂起时同一 AgentRun 的 resume 排队，停止完成后才创建新世代', async () => {
    await agentService.startAgent(launch());
    const oldRuntime = h.instances[0]!;
    const gate = h.deferred();
    oldRuntime.destroyGate = gate.promise;

    const stopping = agentService.stopAgent(oldRuntime.id);
    await waitUntil(() => oldRuntime.destroyCalls === 1);
    const resuming = agentService.resumeAgent(oldRuntime.id);
    await tick();

    expect(h.instances).toHaveLength(1);
    gate.resolve();
    await stopping;
    const state = await resuming;

    expect(state?.agentId).toBe(oldRuntime.id);
    expect(h.instances).toHaveLength(2);
    expect(h.instances[1]).not.toBe(oldRuntime);
  });

  it('destroy 失败后摘牌并隔离该 AgentRun，后续恢复和删除都拒绝', async () => {
    await agentService.startAgent(launch());
    const runtime = h.instances[0]!;
    const failure = new Error('Chromium teardown failed');
    runtime.destroyError = failure;

    await expect(agentService.stopAgent(runtime.id)).rejects.toBe(failure);

    expect(agentService.hasAgentInMemory(runtime.id)).toBe(false);
    expect(service.failedTeardowns.has(runtime.id)).toBe(true);
    await expect(agentService.resumeAgent(runtime.id)).rejects.toThrow('已隔离保护');
    await expect(agentService.deleteAgentRun(runtime.id)).rejects.toThrow('已隔离保护');
  });

  it('interrupt settlement 在生命周期锁外等待，不阻塞升级 stop', async () => {
    await agentService.startAgent(launch());
    const runtime = h.instances[0]!;
    const interruptGate = h.deferred();
    runtime.interruptGate = interruptGate.promise;

    const interrupting = agentService.instantInterrupt(runtime.id);
    await tick();
    await expect(agentService.stopAgent(runtime.id)).resolves.toBeUndefined();
    expect(agentService.hasAgentInMemory(runtime.id)).toBe(false);

    interruptGate.resolve();
    await interrupting;
  });
});

describe('AgentService 激活事务', () => {
  it('新建 prepare 失败会 teardown 并回滚 provisional Header', async () => {
    const failure = new Error('prepare failed');
    h.nextRuntimeTweaks.push((runtime) => { runtime.prepareError = failure; });

    await expect(agentService.startAgent(launch())).rejects.toBe(failure);

    expect(h.instances[0]?.destroyCalls).toBe(1);
    expect(service.conversationStore.readHeader('ag-main-run')).toBeNull();
    expect(agentService.hasAgentInMemory('ag-main-run')).toBe(false);
  });

  it('首次状态构造失败也走 teardown、回滚并发布 failed-start', async () => {
    const failure = new Error('state projection failed');
    h.nextRuntimeTweaks.push((runtime) => { runtime.stateError = failure; });

    await expect(agentService.startAgent(launch())).rejects.toBe(failure);

    expect(h.instances[0]?.destroyCalls).toBe(1);
    expect(service.conversationStore.readHeader('ag-main-run')).toBeNull();
    expect(releases).toEqual([{ agentId: 'ag-main-run', reason: 'failed-start' }]);
  });

  it('resume 激活失败会 teardown，但保留原有磁盘 Header', async () => {
    service.conversationStore.writeHeader('disk-run', header('disk-run'));
    const failure = new Error('resume start failed');
    h.nextRuntimeTweaks.push((runtime) => { runtime.startError = failure; });

    await expect(agentService.resumeAgent('disk-run')).rejects.toBe(failure);

    expect(h.instances[0]?.destroyCalls).toBe(1);
    expect(service.conversationStore.readHeader('disk-run')).toMatchObject({ agentId: 'disk-run' });
    expect(agentService.hasAgentInMemory('disk-run')).toBe(false);
  });
});

describe('AgentService persisted model selection', () => {
  const selectedModel = 'provider-1::chosen-model';
  const event = {
    id: 'sample-event', timestamp: new Date(0), source: 'user' as const,
    content: 'Continue the sample task.', priority: 'normal' as const,
  };
  let root: string;
  let Store: typeof import('../../agent-runs/conversation-store.js').ConversationStore;

  const publicAgents = () => {
    const operations = createAgentController(agentService, {} as never, () => []).operations;
    const context: ControllerContext = {
      generation: 'sample-generation', connectionId: 'sample-connection', windowId: 1,
      signal: new AbortController().signal,
    };
    return createElectronPiskieClient({
      getPathForFile: vi.fn(), version: 'sample', platform: 'linux',
      transport: {
        // Requests execute independently, as they do on the Electron connection.
        request: (id: string, args: unknown[]) => Promise.resolve().then(() => {
          const operation = operations.find((item) => item.id === id)!;
          return operation.execute(context, operation.input.parse(args));
        }),
      } as unknown as ElectronPreloadClient,
    }).agents;
  };

  beforeEach(async () => {
    ({ ConversationStore: Store } = await vi.importActual<typeof import('../../agent-runs/conversation-store.js')>('../../agent-runs/conversation-store.js'));
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sample-model-selection-'));
    service.conversationStore = new Store(root);
    service.conversationStore.writeHeader('disk-run', header('disk-run'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('saves a cold selection without activation and reopens the persisted model before the first message', async () => {
    const before = service.conversationStore.readHeader('disk-run');
    await publicAgents().setModel('disk-run', selectedModel);

    expect(h.instances).toHaveLength(0);
    expect(agentService.hasAgentInMemory('disk-run')).toBe(false);
    expect(agentRunTraceService.attach).not.toHaveBeenCalled();
    const reopened = new Store(root);
    expect(reopened.readHeader('disk-run')).toEqual({ ...before, currentModel: selectedModel });
    service.conversationStore = reopened;
    expect(agentService.buildHistoryPreview('disk-run')?.currentModel).toBe(selectedModel);

    await publicAgents().inject('disk-run', event);
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]?.posted).toEqual([event]);
    expect(h.instances[0]?.postedModels).toEqual([selectedModel]);
    expect(h.instances[0]?.prepareCalls).toBe(1);
    expect(h.instances[0]?.startCalls).toBe(0);
  });

  it.each(['cold', 'active'] as const)('orders consecutive model and message requests for a %s session without a renderer wait', async (phase) => {
    if (phase === 'active') await agentService.resumeAgent('disk-run', { autoStart: false });
    const agents = publicAgents();
    const saving = agents.setModel('disk-run', selectedModel);
    const sending = agents.inject('disk-run', event);
    await Promise.all([saving, sending]);

    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]?.postedModels).toEqual([selectedModel]);
    expect(new Store(root).readHeader('disk-run')?.currentModel).toBe(selectedModel);
  });

  it('queues selection and delivery behind an in-progress restore without overwriting the new model', async () => {
    const gate = h.deferred();
    h.nextRuntimeTweaks.push((runtime) => { runtime.prepareGate = gate.promise; });
    const restoring = agentService.resumeAgent('disk-run', { autoStart: false });
    await waitUntil(() => h.instances[0]?.prepareCalls === 1);
    const agents = publicAgents();
    const acknowledged = vi.fn();
    const saving = agents.setModel('disk-run', selectedModel).then(acknowledged);
    const sending = agents.inject('disk-run', event);
    await tick();
    expect(acknowledged).not.toHaveBeenCalled();
    expect(h.instances[0]?.posted).toEqual([]);
    expect(agentService.hasAgentInMemory('disk-run')).toBe(false);

    gate.resolve();
    await Promise.all([restoring, saving, sending]);
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]?.postedModels).toEqual([selectedModel]);
    expect(new Store(root).readHeader('disk-run')?.currentModel).toBe(selectedModel);
  });

  it('validates a cold model with the shared inference port before changing history', async () => {
    const before = service.conversationStore.readHeader('disk-run');
    const validate = vi.spyOn(h.FakeAgentInference.prototype, 'assertTarget')
      .mockImplementation(() => { throw new Error('Sample model unavailable'); });
    await expect(publicAgents().setModel('disk-run', selectedModel)).rejects.toThrow('Sample model unavailable');
    expect(validate).toHaveBeenCalledWith({ providerId: 'provider-1', modelId: 'chosen-model' });
    expect(new Store(root).readHeader('disk-run')).toEqual(before);
    expect(h.instances).toHaveLength(0);
  });

  it.each(['cold', 'active'] as const)('reports disk write failures without changing the %s model', async (phase) => {
    if (phase === 'active') await agentService.resumeAgent('disk-run', { autoStart: false });
    const before = service.conversationStore.readHeader('disk-run');
    const write = vi.spyOn(service.conversationStore, 'writeHeader')
      .mockImplementation(() => { throw new Error('Sample model save failed'); });
    await expect(publicAgents().setModel('disk-run', selectedModel)).rejects.toThrow('Sample model save failed');
    expect(new Store(root).readHeader('disk-run')).toEqual(before);
    if (phase === 'active') expect(h.instances[0]?.currentModel).toBe(before.currentModel);
    else expect(h.instances).toHaveLength(0);
    write.mockRestore();
    await expect(publicAgents().setModel('disk-run', selectedModel)).resolves.toBeUndefined();
  });

  it('awaits a missing-run result at the controller and leaves history absent', async () => {
    await expect(publicAgents().setModel('missing-run', selectedModel)).rejects.toMatchObject({
      code: 'not-found', message: 'Agent was not found',
    });
    expect(new Store(root).readHeader('missing-run')).toBeNull();
    expect(h.instances).toHaveLength(0);
  });
});

describe('AgentService saved model fallback', () => {
  const unavailableModel = 'removed-provider::saved-model';
  const fallbackModel = 'provider-1::model-1';
  const entries: ConversationEntry[] = [{
    t: 'msg', ts: 1, id: 'message-1', role: 'user', subtype: 'user_input',
    content: 'Remember the sample task.',
  }];
  let diskHeader: ReturnType<typeof header>;

  beforeEach(() => {
    diskHeader = { ...header('disk-run'), currentModel: unavailableModel };
    service.conversationStore.writeHeader('disk-run', diskHeader);
    service.conversationStore.entries.set('disk-run/disk-run', structuredClone(entries));
    vi.spyOn(h.FakeAgentInference.prototype, 'assertTarget').mockImplementation((target) => {
      if (target.providerId !== 'provider-1') {
        throw new Error(`Unavailable model: ${target.providerId}::${target.modelId}`);
      }
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])('restores the same conversation with the default model (autoStart=%s)', async (autoStart) => {
    const state = await agentService.resumeAgent('disk-run', { autoStart });

    expect(state).toMatchObject({
      agentId: 'disk-run', currentModel: fallbackModel, runConfig: diskHeader.runConfig,
    });
    expect(service.conversationStore.readHeader('disk-run')).toMatchObject({
      ...diskHeader, currentModel: fallbackModel, lastActiveAt: expect.any(String),
    });
    expect(h.instances[0]?.replayedEntries).toEqual(entries);
    expect(service.conversationStore.read('disk-run', 'disk-run')).toEqual(entries);
    expect(h.instances[0]?.prepareCalls).toBe(1);
    expect(h.instances[0]?.startCalls).toBe(autoStart ? 1 : 0);
  });

  it('resumes an IM binding and accepts its incoming message without replacing the conversation', async () => {
    const bindings = { get: vi.fn(async () => 'disk-run'), set: vi.fn() };
    const sessions = new MessagingAgentSession(agentService, bindings);
    const resolveLaunch = vi.fn(() => launch());
    const agentId = await sessions.ensure(
      { botId: 'bot-1', peerKind: 'direct', peerId: 'sender-1' }, resolveLaunch,
    );
    const event = {
      id: 'incoming-1', timestamp: new Date(2), source: 'user' as const,
      content: 'Continue the sample task.', priority: 'normal' as const,
    };

    await expect(agentService.injectEventToAgent(agentId, event)).resolves.toBe(true);

    expect(agentId).toBe('disk-run');
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]?.getControlState().currentModel).toBe(fallbackModel);
    expect(h.instances[0]?.replayedEntries).toEqual(entries);
    expect(h.instances[0]?.posted).toEqual([event]);
    expect(h.instances[0]?.startCalls).toBe(0);
    expect(bindings.set).not.toHaveBeenCalled();
    expect(resolveLaunch).not.toHaveBeenCalled();
  });

  it('keeps an available saved model even when the default is different', async () => {
    const savedModel = 'provider-1::saved-model';
    service.conversationStore.writeHeader('disk-run', { ...diskHeader, currentModel: savedModel });

    const state = await agentService.resumeAgent('disk-run', { autoStart: false });

    expect(state?.currentModel).toBe(savedModel);
    expect(service.conversationStore.readHeader('disk-run').currentModel).toBe(savedModel);
  });

  it('preserves history and reports the unavailable model when no default is configured', async () => {
    vi.spyOn(h.FakeInferenceRuntimeHost.prototype, 'readEffectiveSelections').mockResolvedValue({
      schemaVersion: 1, revision: 2,
    });

    await expect(agentService.resumeAgent('disk-run')).rejects.toThrow(`Unavailable model: ${unavailableModel}`);

    expect(h.instances).toHaveLength(0);
    expect(service.conversationStore.readHeader('disk-run')).toEqual(diskHeader);
    expect(service.conversationStore.read('disk-run', 'disk-run')).toEqual(entries);
  });

  it('validates the default before changing the saved model', async () => {
    vi.spyOn(h.FakeInferenceRuntimeHost.prototype, 'readEffectiveSelections').mockResolvedValue({
      schemaVersion: 1, revision: 2,
      ai: { providerId: 'unavailable-default', modelId: 'default-model' },
    });

    await expect(agentService.resumeAgent('disk-run')).rejects.toThrow('Unavailable model: unavailable-default::default-model');

    expect(h.instances).toHaveLength(0);
    expect(service.conversationStore.readHeader('disk-run')).toEqual(diskHeader);
    expect(service.conversationStore.read('disk-run', 'disk-run')).toEqual(entries);
  });
});

describe('AgentService 磁盘恢复与精确删除', () => {
  it.each([true, false])('provides the complete persisted board before resumed execution (autoStart=%s)', async (autoStart) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sample-board-resume-'));
    const { TaskBoardService } = await vi.importActual<typeof import('../../agent-runs/task-board-service.js')>('../../agent-runs/task-board-service.js');
    const boards = new TaskBoardService(root);
    const items = [
      { id: 'done', subject: 'Sample delivery', description: 'Full completed scope and verification facts.', owner: 'worker-stopped', status: 'completed' as const, dependsOn: [] },
      { id: 'open', subject: 'Sample follow-up', description: 'Remaining scope and expected output.', owner: 'worker-stopped', status: 'in_progress' as const, dependsOn: ['done'] },
      { id: 'pending', subject: 'Sample pending work', description: 'Pending acceptance criteria.', owner: null, status: 'pending' as const, dependsOn: ['open'] },
    ];
    try {
      await boards.syncTaskBoard({ mainAgentId: 'disk-run', taskSummary: 'Sample board', items, createdWorkerIds: ['worker-stopped'] });
      const file = path.join(root, 'agent-runs/disk-run/tasks.json');
      const before = await fs.readFile(file, 'utf8');
      vi.mocked(taskBoardService.readTaskBoard).mockImplementationOnce((id) => boards.readTaskBoard(id));
      service.conversationStore.writeHeader('disk-run', header('disk-run'));
      h.nextRuntimeTweaks.push((runtime) => {
        runtime.prepare = async () => {
          runtime.prepareCalls += 1;
          const message = runtime.durableUserMessages.find((entry) => entry.text.startsWith('当前 Task Board：'))!;
          expect(JSON.parse(message.text.slice('当前 Task Board：'.length))).toEqual({ taskSummary: 'Sample board', items });
        };
      });
      await agentService.resumeAgent('disk-run', { autoStart });
      expect(h.instances[0]?.prepareCalls).toBe(1);
      expect(h.instances[0]?.startCalls).toBe(autoStart ? 1 : 0);
      expect(await fs.readFile(file, 'utf8')).toBe(before);
      const message = h.instances[0]!.durableUserMessages.find((entry) => entry.text.startsWith('当前 Task Board：'))!;
      const recovered = JSON.parse(message.text.slice('当前 Task Board：'.length));
      expect((await boards.syncTaskBoard({ mainAgentId: 'disk-run', ...recovered })).board.items).toEqual(items);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('恢复时用精简文案告知已停止 Worker 的 ID 失效', async () => {
    const diskHeader = header('disk-run');
    diskHeader.childAgents = [
      {
        id: 'worker-a',
        config: {
          type: 'local-worker',
          subject: '旧 Assignment',

          prompt: 'work',
        },
        createdAt: Date.now(),
      },
    ];
    service.conversationStore.writeHeader('disk-run', diskHeader);

    await agentService.resumeAgent('disk-run', { autoStart: false });

    expect(h.instances[0]?.durableUserMessages).toEqual([
      {
        text:
          '会话已恢复。以下 Worker 已停止，原 ID 已失效，请勿发送消息：\n' +
          '- worker-a\n\n' +
          '如需继续，请创建新 Worker。',
        tag: 'system_event',
        messageId: 'worker-interruption:worker-a',
      },
    ]);
  });

  it('向冷历史注入事件时只 prepare，然后把原事件投递到恢复后的 Runtime', async () => {
    service.conversationStore.writeHeader('disk-run', header('disk-run'));
    const event = {
      id: 'user-event-1',
      timestamp: new Date('2026-08-19T00:00:00.000Z'),
      source: 'user' as const,
      content: '继续执行',
      priority: 'normal' as const,
    };

    await expect(agentService.injectEventToAgent('disk-run', event)).resolves.toBe(true);

    const runtime = h.instances[0]!;
    expect(runtime.prepareCalls).toBe(1);
    expect(runtime.startCalls).toBe(0);
    expect(runtime.posted).toEqual([event]);
  });

  it('deleteAgentRun 清理 Main 与 Worker owner 数据，再删除整个 AgentRun 目录', async () => {
    await agentService.startAgent(launch());
    service.conversationStore.workers.set('ag-main-run', ['worker-a', 'worker-b']);

    await agentService.deleteAgentRun('ag-main-run');

    expect(h.browserDelete.mock.calls.map(([agentId]) => agentId)).toEqual([
      'ag-main-run',
      'worker-a',
      'worker-b',
    ]);
    expect(service.conversationStore.readHeader('ag-main-run')).toBeNull();
    expect(releases).toEqual([{ agentId: 'ag-main-run', reason: 'deleted' }]);
  });

  it('精确停止 Worker 只调用所属 Main 的子模块，不销毁 Main', async () => {
    await agentService.startAgent(launch());
    const runtime = h.instances[0]!;
    const stopSubagentById = vi.fn(async () => undefined);
    runtime.subagentModule = {
      getSubagent: (id: string) => id === 'worker-a' ? { id } : undefined,
      stopSubagentById,
    };

    await agentService.stopSubagent('worker-a');

    expect(stopSubagentById).toHaveBeenCalledWith('worker-a', 'environment_stop');
    expect(runtime.destroyCalls).toBe(0);
    expect(agentService.hasAgentInMemory(runtime.id)).toBe(true);
  });
});

describe('AgentService 世代观察与升级通道', () => {
  it('旧世代迟到输出不会越过当前世代守卫', async () => {
    await agentService.startAgent(launch());
    const oldRuntime = h.instances[0]!;
    await agentService.stopAgent(oldRuntime.id);
    await agentService.resumeAgent(oldRuntime.id);
    const currentRuntime = h.instances[1]!;
    outputs.length = 0;

    oldRuntime.config.observer.contentProduced({ type: 'assistant_text', content: 'stale' });
    currentRuntime.config.observer.contentProduced({ type: 'assistant_text', content: 'current' });

    expect(outputs).toEqual([
      { agentId: currentRuntime.id, type: 'assistant_text', content: 'current' },
    ]);
  });

  it('旧世代迟到的 fatal teardown 不会停止当前世代', async () => {
    await agentService.startAgent(launch());
    const oldRuntime = h.instances[0]!;
    const staleHandler = oldRuntime.config.options.onFatalTeardown as (error: unknown) => void;
    await agentService.stopAgent(oldRuntime.id);
    await agentService.resumeAgent(oldRuntime.id);
    const currentRuntime = h.instances[1]!;

    staleHandler(new Error('late teardown report'));
    await tick();

    expect(currentRuntime.destroyCalls).toBe(0);
    expect(agentService.hasAgentInMemory(currentRuntime.id)).toBe(true);
  });

  it('应用关闭仅在 Runtime teardown 成功后发布 shutdown release 并保留 Header', async () => {
    await agentService.startAgent(launch());
    const runtime = h.instances[0]!;
    runtime.headerChildren = [{
      id: 'worker-open',
      config: { type: 'local-worker', subject: 'unfinished', prompt: 'work' },
      createdAt: Date.now(),
    }];
    releases.length = 0;

    await agentService.destroyApplication();

    expect(runtime.destroyCalls).toBe(1);
    expect(releases).toEqual([{ agentId: runtime.id, reason: 'shutdown' }]);
    expect(service.conversationStore.readHeader(runtime.id)?.childAgents).toEqual(runtime.headerChildren);
  });
});

function launch() {
  return {
    runConfig: runConfig(),
    agentSpec: directorSpec,
    initialModeId: 'normal' as const,
    initialApprovalMode: 'confirm' as const,
    launchOptions: { initialModel: 'provider-1::model-1' },
  };
}

function runConfig() {
  return {
    name: 'Lifecycle run',
    description: 'Lifecycle coverage',
    promptTemplate: 'Complete the lifecycle task.',
    workspace: '/workspace',
  };
}

function header(agentId: string): AgentRunHeader {
  return {
    agentId,
    agentSpec: 'director',
    modeId: 'normal',
    runConfig: runConfig(),
    createdAt: '2026-08-19T00:00:00.000Z',
    lastActiveAt: '2026-08-19T00:00:00.000Z',
    currentModel: 'provider-1::model-1',
    approvalMode: 'confirm',
    childAgents: [],
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitUntil(condition: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts && !condition(); attempt += 1) await tick();
  if (!condition()) throw new Error('waitUntil condition not met');
}
