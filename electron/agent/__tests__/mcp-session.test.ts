import { describe, expect, it, vi } from 'vitest';
import type { EffectiveMcpServer, McpServerSnapshot } from '../../../shared/types/mcp.js';
import type { McpCatalogCandidate } from '../../mcp/runtime/server-runtime.js';
import type { McpCapabilitySnapshot } from '../../mcp/runtime/capability.js';
import type {
  McpProjectionViewInput,
  McpSessionRuntimeHandle,
} from '../../mcp/runtime/session-runtime.js';
import { AgentMcpSession } from '../mcp-session.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

function server(name: string): EffectiveMcpServer {
  return {
    name,
    origin: 'global-explicit',
    transport: 'stdio',
    config: { command: 'node', args: [`${name}.mjs`] },
  };
}

function candidate(value: EffectiveMcpServer): McpCatalogCandidate {
  const snapshot: McpServerSnapshot = {
    server: value.name,
    tools: [{
      name: 'remote',
      description: 'x'.repeat(80),
      inputSchema: { type: 'object', properties: {} },
    }],
    fetchedAt: new Date(0).toISOString(),
    configFingerprint: `config-${value.name}`,
  };
  return {
    key: {
      sessionRuntimeId: 'session-worker',
      serverName: value.name,
      launchFingerprint: `launch-${value.name}`,
    },
    epoch: 1,
    server: value,
    snapshot,
    source: 'live',
    catalogFingerprint: `catalog-${value.name}`,
  };
}

function capability(servers: readonly EffectiveMcpServer[]): McpCapabilitySnapshot {
  return {
    projectContextId: 'project:/workspace',
    workspace: '/workspace',
    servers,
    blocked: [],
    warnings: [],
    fingerprint: 'capability',
  };
}

describe('AgentMcpSession append-only projection', () => {
  it('plans all catalogs ready at one boundary as a batch before upgrading direct exposure', async () => {
    const first = server('first');
    const second = server('second');
    const handle = {
      sessionRuntimeId: 'session-worker',
      capability: capability([first, second]),
      waitForInitialGrace: vi.fn().mockResolvedValue(undefined),
      catalogs: () => [candidate(first), candidate(second)],
      view: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpSessionRuntimeHandle;
    // Individually the first tool fits direct and leaves too little for the second name line.
    // Batch planning reserves both name lines first, so neither ready server is hidden.
    const session = new AgentMcpSession(handle, 54, 1);

    const snapshot = await session.advanceBoundary(new AbortController().signal);

    expect(snapshot.entries.map((entry) => [entry.identity?.kind === 'mcp'
      ? entry.identity.server
      : '', entry.exposure])).toEqual([
      ['first', 'deferred'],
      ['second', 'deferred'],
    ]);
    expect(snapshot.promptBlock).toContain('mcp__first__remote');
    expect(snapshot.promptBlock).toContain('mcp__second__remote');
    expect([...snapshot.publishedServers]).toEqual(['first', 'second']);
  });

  it('uses one initial grace and never reclassifies an already published server when an earlier server arrives late', async () => {
    const earlier = server('earlier');
    const firstReady = server('first-ready');
    let catalogs: readonly McpCatalogCandidate[] = [candidate(firstReady)];
    const waitForInitialGrace = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const handle = {
      sessionRuntimeId: 'session-worker',
      capability: capability([earlier, firstReady]),
      waitForInitialGrace,
      catalogs: () => catalogs,
      view: vi.fn((input) => ({
        sessionRuntimeId: 'session-worker',
        total: 2,
        ready: 2,
        starting: 0,
        dormant: 0,
        failed: 0,
        blocked: 0,
        projectionRevision: input?.revision ?? 0,
        servers: [],
      })),
      release,
    } as unknown as McpSessionRuntimeHandle;
    // 60 tokens: one 80-char tool fits direct, the remaining budget only fits a name line.
    const session = new AgentMcpSession(handle, 60, 1);
    const signal = new AbortController().signal;

    const first = await session.advanceBoundary(signal);
    expect(first.revision).toBe(1);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0].identity).toMatchObject({ server: 'first-ready' });
    expect(first.entries[0].exposure).toBe('direct');
    const stableFirstEntry = first.entries[0];

    catalogs = [candidate(earlier), candidate(firstReady)];
    const second = await session.advanceBoundary(signal);

    expect(waitForInitialGrace).toHaveBeenCalledOnce();
    expect(second.revision).toBe(2);
    expect(second.entries).toHaveLength(2);
    expect(second.entries[0]).toBe(stableFirstEntry);
    expect(second.entries[0].exposure).toBe('direct');
    expect(second.entries[1].identity).toMatchObject({ server: 'earlier' });
    expect(second.entries[1].exposure).toBe('deferred');
    expect(second.promptBlock).toContain('mcp__earlier__remote');
    expect(Object.isFrozen(second.entries)).toBe(true);
    expect(session.view().projectionRevision).toBe(2);

    await session.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it('derives modelName from raw identity rather than server ready order', async () => {
    const left = server('srv.one');
    const right = server('srv/one');
    const project = async (first: EffectiveMcpServer) => {
      let catalogs: readonly McpCatalogCandidate[] = [candidate(first)];
      const handle = {
        sessionRuntimeId: `session-${first.name}`,
        capability: capability([left, right]),
        waitForInitialGrace: vi.fn().mockResolvedValue(undefined),
        catalogs: () => catalogs,
        view: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined),
      } as unknown as McpSessionRuntimeHandle;
      const session = new AgentMcpSession(handle, 10_000, 1);
      const signal = new AbortController().signal;
      await session.advanceBoundary(signal);
      catalogs = [candidate(left), candidate(right)];
      const snapshot = await session.advanceBoundary(signal);
      return new Map(snapshot.entries.map((entry) => [
        entry.identity?.kind === 'mcp' ? entry.identity.server : '',
        entry.modelName,
      ]));
    };

    const leftFirst = await project(left);
    const rightFirst = await project(right);

    expect(leftFirst).toEqual(rightFirst);
    expect(leftFirst.get(left.name)).not.toBe(leftFirst.get(right.name));
  });

  it('settles hidden and zero-entry servers without publishing them or advancing the revision', async () => {
    const hidden = server('hidden');
    const empty = server('empty');
    const emptyCandidate = candidate(empty);
    const catalogs: readonly McpCatalogCandidate[] = [
      candidate(hidden),
      {
        ...emptyCandidate,
        snapshot: { ...emptyCandidate.snapshot, tools: [] },
      },
    ];
    const view = vi.fn((_input?: McpProjectionViewInput) => ({
      sessionRuntimeId: 'session-worker',
      total: 2,
      ready: 2,
      starting: 0,
      dormant: 0,
      failed: 0,
      blocked: 0,
      projectionRevision: 0,
      servers: [],
    }));
    const handle = {
      sessionRuntimeId: 'session-worker',
      capability: capability([hidden, empty]),
      waitForInitialGrace: vi.fn().mockResolvedValue(undefined),
      catalogs: () => catalogs,
      view,
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpSessionRuntimeHandle;
    const session = new AgentMcpSession(handle, 0, 1);

    const snapshot = await session.advanceBoundary(new AbortController().signal);
    expect(snapshot.revision).toBe(0);
    expect(snapshot.entries).toEqual([]);
    expect([...snapshot.publishedServers]).toEqual([]);
    expect([...snapshot.settledServers]).toEqual(['hidden', 'empty']);

    session.view();
    const viewInput = view.mock.lastCall?.[0];
    expect([...(viewInput?.publishedServers ?? [])]).toEqual([]);
    expect([...(viewInput?.settledServers ?? [])]).toEqual(['hidden', 'empty']);
  });

  it('reconsiders a cached empty catalog when live discovery reports a changed catalog', async () => {
    const target = server('cached-empty');
    const liveCandidate = candidate(target);
    let catalogs: readonly McpCatalogCandidate[] = [{
      ...liveCandidate,
      source: 'cache',
      catalogFingerprint: 'catalog-empty',
      snapshot: { ...liveCandidate.snapshot, tools: [] },
    }];
    const handle = {
      sessionRuntimeId: 'session-worker',
      capability: capability([target]),
      waitForInitialGrace: vi.fn().mockResolvedValue(undefined),
      catalogs: () => catalogs,
      view: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpSessionRuntimeHandle;
    const session = new AgentMcpSession(handle, 10_000, 1);
    const signal = new AbortController().signal;

    const cachedBoundary = await session.advanceBoundary(signal);
    expect(cachedBoundary).toMatchObject({ revision: 0, entries: [] });
    expect(cachedBoundary.settledServers).toEqual(['cached-empty']);

    catalogs = [{
      ...liveCandidate,
      source: 'live',
      catalogFingerprint: 'catalog-live-with-tool',
    }];
    const liveBoundary = await session.advanceBoundary(signal);

    expect(liveBoundary.revision).toBe(1);
    expect(liveBoundary.entries).toHaveLength(1);
    expect(liveBoundary.entries[0].identity).toMatchObject({
      kind: 'mcp',
      server: 'cached-empty',
      tool: 'remote',
    });
    expect(liveBoundary.publishedServers).toEqual(['cached-empty']);
  });

  it('appends live-only instructions after a cached direct schema without replacing entries', async () => {
    const target = server('cached-direct');
    const base = candidate(target);
    let catalogs: readonly McpCatalogCandidate[] = [{ ...base, source: 'cache', epoch: 0 }];
    const handle = {
      sessionRuntimeId: 'session-worker',
      capability: capability([target]),
      waitForInitialGrace: vi.fn().mockResolvedValue(undefined),
      catalogs: () => catalogs,
      view: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpSessionRuntimeHandle;
    const session = new AgentMcpSession(handle, 10_000, 1);
    const signal = new AbortController().signal;

    const cachedBoundary = await session.advanceBoundary(signal);
    expect(cachedBoundary.entries[0]?.exposure).toBe('direct');
    expect(cachedBoundary.promptBlock ?? '').not.toContain('live-only guidance');
    const stableEntry = cachedBoundary.entries[0];

    catalogs = [{
      ...base,
      source: 'live',
      snapshot: { ...base.snapshot, instructions: 'live-only guidance' },
    }];
    const liveBoundary = await session.advanceBoundary(signal);

    expect(liveBoundary.revision).toBe(cachedBoundary.revision + 1);
    expect(liveBoundary.entries).toEqual([stableEntry]);
    expect(liveBoundary.promptBlock).toContain('live-only guidance');
    expect((liveBoundary.promptBlock?.match(/live-only guidance/g) ?? [])).toHaveLength(1);
    expect(await session.advanceBoundary(signal)).toBe(liveBoundary);
  });

  it('does not exceed the projection budget when cached direct tools gain live instructions', async () => {
    const target = server('cached-budget');
    const base = candidate(target);
    let catalogs: readonly McpCatalogCandidate[] = [{ ...base, source: 'cache', epoch: 0 }];
    const handle = {
      sessionRuntimeId: 'session-worker',
      capability: capability([target]),
      waitForInitialGrace: vi.fn().mockResolvedValue(undefined),
      catalogs: () => catalogs,
      view: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpSessionRuntimeHandle;
    const session = new AgentMcpSession(handle, 80, 1);
    const signal = new AbortController().signal;
    const cachedBoundary = await session.advanceBoundary(signal);
    expect(cachedBoundary.entries[0]?.exposure).toBe('direct');

    catalogs = [{
      ...base,
      source: 'live',
      snapshot: { ...base.snapshot, instructions: 'DO-NOT-INJECT '.repeat(200) },
    }];
    const liveBoundary = await session.advanceBoundary(signal);

    expect(liveBoundary.revision).toBe(cachedBoundary.revision);
    expect(liveBoundary.promptBlock ?? '').not.toContain('DO-NOT-INJECT');
    expect(liveBoundary.warnings).toEqual([
      expect.stringContaining('live instructions 未注入'),
    ]);
    expect(await session.advanceBoundary(signal)).toBe(liveBoundary);
  });

  it('never injects live instructions for a cached deferred server', async () => {
    const target = server('cached-deferred');
    const base = candidate(target);
    let catalogs: readonly McpCatalogCandidate[] = [{ ...base, source: 'cache', epoch: 0 }];
    const handle = {
      sessionRuntimeId: 'session-worker',
      capability: capability([target]),
      waitForInitialGrace: vi.fn().mockResolvedValue(undefined),
      catalogs: () => catalogs,
      view: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpSessionRuntimeHandle;
    const session = new AgentMcpSession(handle, 30, 1);
    const signal = new AbortController().signal;
    const cachedBoundary = await session.advanceBoundary(signal);
    expect(cachedBoundary.entries[0]?.exposure).toBe('deferred');

    catalogs = [{
      ...base,
      source: 'live',
      snapshot: { ...base.snapshot, instructions: 'deferred instructions must stay out' },
    }];
    const liveBoundary = await session.advanceBoundary(signal);

    expect(liveBoundary).toBe(cachedBoundary);
    expect(liveBoundary.promptBlock ?? '').not.toContain('deferred instructions must stay out');
  });
});
