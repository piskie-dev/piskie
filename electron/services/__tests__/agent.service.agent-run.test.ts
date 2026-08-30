import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  let sequence = 0;
  const instances: any[] = [];

  class FakeRuntime {
    id: string;
    mainAgentId: string;
    config: any;
    prepareCalls = 0;
    startCalls = 0;
    destroyCalls = 0;

    constructor(config: any) {
      this.config = config;
      this.id = config.id ?? `agent-${++sequence}`;
      this.mainAgentId = config.options.mainAgentId;
      instances.push(this);
    }

    async prepare(): Promise<void> {
      this.prepareCalls += 1;
    }

    async start(): Promise<void> {
      this.startCalls += 1;
    }

    async destroy(): Promise<void> {
      this.destroyCalls += 1;
    }

    async replayConversation(): Promise<void> {}
    repairConversationTail(): void {}
    addDurableUserMessage(): void {}
    listChildAgents(): unknown[] { return []; }
    getModule(): undefined { return undefined; }

    buildHeader() {
      return header(
        this.id,
        this.config.options.runConfig,
        this.config.spec.name,
        this.config.options.initialModeId,
        this.config.options.initialApprovalMode,
        this.config.options.initialModel,
      );
    }

    getControlState() {
      return {
        agentId: this.id,
        phase: 'waiting',
        interrupted: false,
        currentModel: this.config.options.initialModel,
        reasoningOverride: { kind: 'provider-default' },
        approvalMode: this.config.options.initialApprovalMode,
        modeId: this.config.options.initialModeId,
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
    readHeaderCalls: string[] = [];
    constructor(_root?: string) {}
    subscribeAppends(): () => void { return () => undefined; }
    writeHeader(mainAgentId: string, value: any): void {
      this.headers.set(mainAgentId, structuredClone(value));
    }
    readHeader(mainAgentId: string) {
      this.readHeaderCalls.push(mainAgentId);
      const value = this.headers.get(mainAgentId);
      return value ? structuredClone(value) : null;
    }
    scanHeaders() { return structuredClone([...this.headers.values()]); }
    findMainAgentId(agentId: string) { return this.headers.has(agentId) ? agentId : null; }
    hasAgentId(agentId: string) { return this.findMainAgentId(agentId) !== null; }
    read(): unknown[] { return []; }
    append(): void {}
    count(): number { return 0; }
    listWorkerIds(): string[] { return []; }
    deleteAgentRun(mainAgentId: string): void { this.headers.delete(mainAgentId); }
  }

  const incidentStore = { raise: vi.fn(), clearAgent: vi.fn(), clearAll: vi.fn() };

  class FakeInferenceRuntimeHost {
    aiGateway = {};
    imageGateway = {};
    artifacts = {};
    configHost = {};
    control = { runtime: { capture: () => ({ configRevision: 1 }) } };
    selections = {
      read: async () => ({
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
    assertTarget(): void {}
    contextWindow(): number { return 200_000; }
  }

  class FakeImageApplication {
    hasTarget(): boolean { return true; }
  }

  return {
    FakeRuntime,
    FakeStore,
    instances,
    incidentStore,
    FakeInferenceRuntimeHost,
    FakeAgentInference,
    FakeImageApplication,
    reset() {
      sequence = 0;
      instances.length = 0;
      incidentStore.raise.mockClear();
      incidentStore.clearAgent.mockClear();
    },
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/agent-service-agent-run-test', on: () => undefined },
}));
vi.mock('../../agent/agent-runtime.js', () => ({ AgentRuntime: h.FakeRuntime }));
vi.mock('../../agent/agent-engine.js', () => ({ AgentEngine: class {} }));
vi.mock('../../agent/specs/index.js', () => {
  const specs = new Map([
    ['director', { name: 'director', role: 'director' }],
    ['browser-skill-director', { name: 'browser-skill-director', role: 'director' }],
  ]);
  return {
    specRegistry: { get: (name: string) => specs.get(name) },
  };
});
vi.mock('../../agent-runs/conversation-store.js', () => ({ ConversationStore: h.FakeStore }));
vi.mock('../../core/pilot/index.js', () => ({
  agentPilotPorts: { skills: {}, browser: {} },
  browserControlPort: { deleteUserDataById: vi.fn(async () => undefined) },
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
vi.mock('../../agent-runs/agent-run-trace-service.js', () => ({
  agentRunTraceService: {
    attach: vi.fn(async () => ({ contentProduced: () => undefined })),
    detach: vi.fn(async () => undefined),
    recordLifecycle: vi.fn(),
  },
}));
vi.mock('../../agent-runs/task-board-service.js', () => ({
  taskBoardService: { releaseStaleWorkerTasks: vi.fn(async () => undefined) },
}));
vi.mock('../../core/occupancy/index.js', () => ({
  occupancyRegistry: {
    clear: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    claim: vi.fn(() => ({ ok: true })),
    releaseAllOwnedBy: vi.fn(() => 0),
    find: vi.fn(() => undefined),
    list: () => [],
  },
}));

import { directorSpec } from '../../agent/specs/builtin/director.js';
import { agentService } from '../agent.service.js';

const service = agentService as any;

beforeAll(async () => {
  const bindings = {
    userDataDirectory: '/tmp/agent-service-agent-run-test',
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
});

describe('AgentService AgentRun start and resume', () => {
  it('allocates a fresh agentId for every start, even with the same run config', async () => {
    const candidates = ['AAAAAA', 'BBBBBB'];
    service.createAgentCandidate = () => candidates.shift()!;

    const first = await agentService.startAgent(launch());
    const second = await agentService.startAgent(launch());

    expect(first.agentId).toBe('ag-AAAAAA');
    expect(second.agentId).toBe('ag-BBBBBB');
    expect(service.conversationStore.scanHeaders().map((value: any) => value.agentId))
      .toEqual(['ag-AAAAAA', 'ag-BBBBBB']);
  });

  it('retries an agentId that already owns a persisted AgentRun', async () => {
    service.conversationStore.writeHeader(
      'ag-AAAAAA',
      header('ag-AAAAAA', runConfig('Existing run')),
    );
    const candidates = ['AAAAAA', 'b8Z2Km'];
    service.createAgentCandidate = () => candidates.shift()!;

    const state = await agentService.startAgent(launch('Fresh run'));

    expect(state.agentId).toBe('ag-b8Z2Km');
  });

  it('persists the resolved AgentRun snapshot without a TaskDefinition identity', async () => {
    service.createAgentCandidate = () => 'AAAAAA';

    await agentService.startAgent(launch('Frozen task'));
    const stored = service.conversationStore.readHeader('ag-AAAAAA');

    expect(stored).toMatchObject({
      agentId: 'ag-AAAAAA',
      agentSpec: 'director',
      modeId: 'normal',
      runConfig: runConfig('Frozen task'),
    });
    expect(stored).not.toHaveProperty('definitionId');
  });

  it('resumes from Header and disk artifacts using the same agentId', async () => {
    service.conversationStore.writeHeader(
      'main-history',
      header('main-history', runConfig('Disk snapshot'), 'director', 'plan', 'auto'),
    );

    const state = await agentService.resumeAgent('main-history', { autoStart: false });

    expect(state).toMatchObject({
      agentId: 'main-history',
      modeId: 'plan',
      approvalMode: 'auto',
      runConfig: runConfig('Disk snapshot'),
    });
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.prepareCalls).toBe(1);
    expect(h.instances[0]!.startCalls).toBe(0);
  });

  it('resumes Browser Skill with the persisted mode and dedicated AgentSpec', async () => {
    service.conversationStore.writeHeader(
      'browser-skill-history',
      header(
        'browser-skill-history',
        runConfig('Browser Skill snapshot'),
        'browser-skill-director',
        'browser-skill',
        'confirm',
      ),
    );

    const state = await agentService.resumeAgent('browser-skill-history', { autoStart: false });

    expect(state).toMatchObject({
      agentId: 'browser-skill-history',
      agentSpec: 'browser-skill-director',
      modeId: 'browser-skill',
    });
    expect(h.instances[0]!.config.spec.name).toBe('browser-skill-director');
  });

  it('returns null when no AgentRun Header exists', async () => {
    await expect(agentService.resumeAgent('missing')).resolves.toBeNull();
    expect(h.instances).toHaveLength(0);
  });
});

function launch(name = 'Task') {
  return {
    runConfig: runConfig(name),
    agentSpec: directorSpec,
    initialModeId: 'normal' as const,
    initialApprovalMode: 'confirm' as const,
    launchOptions: { initialModel: 'provider-1::model-1' },
  };
}

function runConfig(name: string) {
  return {
    name,
    description: `${name} description`,
    promptTemplate: `${name} prompt`,
    workspace: '/workspace',
  };
}

function header(
  agentId: string,
  config: ReturnType<typeof runConfig>,
  agentSpec = 'director',
  modeId = 'normal',
  approvalMode = 'confirm',
  currentModel = 'provider-1::model-1',
) {
  return {
    agentId,
    agentSpec,
    modeId,
    runConfig: structuredClone(config),
    createdAt: '2026-08-19T00:00:00.000Z',
    lastActiveAt: '2026-08-19T00:00:00.000Z',
    currentModel,
    approvalMode,
    childAgents: [],
  };
}
