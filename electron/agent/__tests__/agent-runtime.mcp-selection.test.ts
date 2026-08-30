import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpCapabilitySnapshot } from '../../mcp/runtime/capability.js';
import type { McpSessionRuntimeHandle } from '../../mcp/runtime/session-runtime.js';

const manager = vi.hoisted(() => ({
  createSession: vi.fn(),
  adoptPrewarm: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test', on: () => undefined },
}));

vi.mock('../../services/paths.service.js', () => ({
  pathsService: {
    getDefaultWorkspaceDir: () => '/tmp/piskie-test/workspace',
    getTempDir: (agentId: string) => `/tmp/piskie/${agentId}`,
    ensureTempDir: vi.fn().mockResolvedValue(undefined),
    ensureWorkspace: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: { raise: vi.fn(), recover: vi.fn() },
}));
vi.mock('../../agent-runs/compaction-archive.js', () => ({
  compactionArchive: { saveCompaction: vi.fn(), loadCompactions: vi.fn(() => []) },
}));
vi.mock('../../mcp/runtime/index.js', () => ({ mcpConnectionManager: manager }));
vi.mock('../../mcp/bridge/injection.js', () => ({
  intersectMcpSelections: (run?: readonly string[], spec?: readonly string[]) => {
    if (run === undefined && spec === undefined) return undefined;
    const ordered = run ?? spec ?? [];
    const allowed = spec === undefined ? undefined : new Set(spec);
    return [...new Set(ordered)].filter((name) => allowed === undefined || allowed.has(name));
  },
  renderMcpPromptBlock: () => undefined,
}));

import { AgentRuntime } from '../agent-runtime.js';
import type { AgentSpec } from '../specs/spec.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';

function capability(names: readonly string[] = []): McpCapabilitySnapshot {
  return {
    projectContextId: 'project:/workspace',
    workspace: '/workspace',
    servers: names.map((name) => ({
      name,
      origin: 'global-explicit' as const,
      transport: 'stdio' as const,
      config: { command: 'node' },
    })),
    blocked: [],
    warnings: [],
    fingerprint: `cap-${names.join('-')}`,
  };
}

function handle(value = capability()): McpSessionRuntimeHandle {
  return {
    sessionRuntimeId: 'mcp-session-test',
    capability: value,
    ownerId: 'owner',
    ownerKind: 'main',
    startAll: vi.fn(),
    waitForInitialGrace: vi.fn().mockResolvedValue(undefined),
    catalogs: vi.fn(() => []),
    call: vi.fn(),
    callTool: vi.fn(),
    view: vi.fn(() => ({
      sessionRuntimeId: 'mcp-session-test',
      total: 0,
      ready: 0,
      starting: 0,
      dormant: 0,
      failed: 0,
      blocked: 0,
      projectionRevision: 0,
      servers: [],
    })),
    onChange: vi.fn(() => () => undefined),
    retry: vi.fn(),
    release: vi.fn().mockResolvedValue(undefined),
  } as McpSessionRuntimeHandle;
}

function runtime(
  role: 'director' | 'worker',
  specSelection?: readonly string[],
  options: Record<string, unknown> = {},
): AgentRuntime {
  const spec: AgentSpec = {
    name: `${role}-test`,
    role,
    modules: [],
    tools: { sdkGroups: [], customTools: [] },
    buildSystemPrompt: () => '',
    mcpServers: specSelection,
  };
  return new AgentRuntime({
    id: `${role}-runtime`,
    spec,
    inference: fakeAgentInference(),
    conversationStore: { append: vi.fn(), count: vi.fn(() => 0) } as never,
    options: {
      mainAgentId: 'director-runtime',
      initialModel: 'provider::model',
      initialModeId: 'normal',
      initialApprovalMode: 'confirm',
      runConfig: {
        name: 'MCP Run',
        description: 'MCP Run',
        promptTemplate: 'MCP Run',
        workspace: '/workspace',
        mcpServers: ['beta', 'alpha'],
      },
      ...(role === 'worker'
        ? {
            mainAgentId: 'parent-1',
            subagentConfig: {
              mode: 'local', skills: [], subject: 'task', taskIds: [], prompt: 'task',
            },
          }
        : {}),
      ...options,
    } as never,
  });
}

async function prepareMcp(instance: AgentRuntime): Promise<void> {
  await (instance as unknown as { prepareMcpSession(): Promise<void> }).prepareMcpSession();
}

describe('AgentRuntime MCP session ownership and capability narrowing', () => {
  beforeEach(() => {
    manager.createSession.mockReset().mockResolvedValue(handle());
    manager.adoptPrewarm.mockReset().mockResolvedValue(null);
  });

  it('Main applies AgentRun then Spec selection and starts its own runtime without awaiting discovery', async () => {
    const instance = runtime('director', ['alpha', 'outside']);

    await prepareMcp(instance);

    expect(manager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'director-runtime',
      ownerKind: 'main',
      ownerLabel: 'MCP Run',
      workspace: '/workspace',
      selection: ['alpha'],
    }));
    expect(manager.createSession.mock.calls[0][0]).not.toHaveProperty('sessionRuntimeId');
    const created = await manager.createSession.mock.results[0].value;
    expect(created.startAll).toHaveBeenCalledOnce();
    expect(created.waitForInitialGrace).not.toHaveBeenCalled();
  });

  it('MCP status changes publish state without posting Mailbox events or starting a Pump', async () => {
    let notifyMcpChange: (() => void) | undefined;
    const owned = handle(capability(['alpha']));
    vi.mocked(owned.onChange).mockImplementation((listener) => {
      notifyMcpChange = listener;
      return () => undefined;
    });
    manager.createSession.mockResolvedValue(owned);
    const instance = runtime('director', ['alpha']);
    const post = vi.spyOn(instance, 'post');
    const emitStateChange = vi.spyOn(instance, 'emitStateChange');
    await prepareMcp(instance);
    post.mockClear();
    emitStateChange.mockClear();

    expect(instance.isPumping).toBe(false);
    notifyMcpChange?.();

    expect(emitStateChange).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
    expect(instance.isPumping).toBe(false);
  });

  it('Worker narrows the Main capability snapshot by Worker Spec and never requests a disk rescan', async () => {
    const parentCapability = capability(['beta', 'alpha']);
    const instance = runtime('worker', ['alpha', 'outside'], { parentMcpCapability: parentCapability });

    await prepareMcp(instance);

    expect(manager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'worker-runtime',
      ownerKind: 'worker',
      ownerLabel: 'task',
      parentCapability,
      selection: ['alpha', 'outside'],
    }));
    expect(manager.createSession.mock.calls[0][0]).not.toHaveProperty('capability');
  });

  it('Main atomically adopts an exact composer prewarm and does not create a second connection set', async () => {
    const adopted = handle(capability(['alpha']));
    manager.adoptPrewarm.mockResolvedValue(adopted);
    const instance = runtime('director', ['alpha'], { mcpPrewarmToken: 'prewarm-token' });

    await prepareMcp(instance);

    expect(manager.adoptPrewarm).toHaveBeenCalledWith(
      'prewarm-token',
      expect.objectContaining({ ownerId: 'director-runtime', ownerKind: 'main' }),
    );
    expect(manager.createSession).not.toHaveBeenCalled();
    expect(adopted.startAll).toHaveBeenCalledOnce();
  });

  it('destroy awaits the owning MCP session release', async () => {
    const owned = handle(capability(['alpha']));
    manager.createSession.mockResolvedValue(owned);
    const instance = runtime('director', ['alpha']);
    await prepareMcp(instance);

    await instance.destroy();

    expect(owned.release).toHaveBeenCalledOnce();
  });

  it('destroy closes Worker runtimes before releasing the Main MCP session', async () => {
    const events: string[] = [];
    let finishWorker!: () => void;
    const workerClosed = new Promise<void>((resolve) => { finishWorker = resolve; });
    const owned = handle(capability(['alpha']));
    vi.mocked(owned.release).mockImplementation(async () => { events.push('main-mcp'); });
    manager.createSession.mockResolvedValue(owned);
    const instance = runtime('director', ['alpha']);
    await prepareMcp(instance);
    (instance as unknown as { modules: Array<Record<string, unknown>> }).modules.push({
      name: 'subagent',
      onDestroyBegin: () => {
        events.push('worker-start');
        return workerClosed.then(() => { events.push('worker-closed'); });
      },
    });

    const destroying = instance.destroy();
    expect(events).toEqual(['worker-start']);
    expect(owned.release).not.toHaveBeenCalled();

    finishWorker();
    await destroying;
    expect(events).toEqual(['worker-start', 'worker-closed', 'main-mcp']);
  });

  it('MCP capability/session setup failure is non-fatal to Agent prepare', async () => {
    manager.createSession.mockRejectedValue(new Error('broken MCP config source'));
    const instance = runtime('director', ['alpha']);

    await expect(instance.prepare()).resolves.toBeUndefined();
    expect(instance.getAvailableTools()).toBeDefined();
  });
});
