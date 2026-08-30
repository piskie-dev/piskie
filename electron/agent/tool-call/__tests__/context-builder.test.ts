import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));
import { z } from '../../../tools/params.js';
import type { CatalogEntry, CatalogSnapshot } from '../../../tools/catalog.js';
import type { ITool } from '../../../tools/types.js';
import { ToolCallContextFactory, type ToolActivationContext } from '../context-builder.js';

function entry(domain?: 'local' | 'browser'): CatalogEntry {
  const tool: ITool<Record<string, never>> = {
    def: {
      name: 'probe',
      description: 'probe',
      schema: z.object({}),
      scope: 'shared',
      effects: [],
    },
    async execute() {
      return { ok: true, text: 'ok' };
    },
  };
  return {
    modelName: 'probe',
    tool,
    trust: 'builtin',
    identity: domain
      ? { kind: 'skill', skill: 'probe-skill', function: 'probe', domain, entryPoint: 'direct' }
      : undefined,
  };
}

function activation(overrides: Partial<ToolActivationContext> = {}): ToolActivationContext {
  return {
    agentType: 'main',
    agentSpec: 'director',
    agentId: 'agent-1',
    mainAgentId: 'agent-1',
    runConfig: { name: 'run', description: '', promptTemplate: '' },
    resourceIds: {},
    currentModel: () => 'provider::v1',
    workspace: { dir: '/workspace', tempDir: '/tmp/agent-1' },
    modes: { modeId: () => 'normal', approvalMode: () => 'auto' },
    post: () => true,
    ...overrides,
  };
}

describe('ToolCallContextFactory', () => {
  it('binds tool_search deferred tools to the CatalogSnapshot supplied by its coordinator run', () => {
    const early = {
      deferredTools: () => [{ modelName: 'mcp__srv__early', server: 'srv', description: 'early' }],
    } as CatalogSnapshot;
    const late = {
      deferredTools: () => [{ modelName: 'mcp__srv__late', server: 'srv', description: 'late' }],
    } as CatalogSnapshot;
    const searchEntry: CatalogEntry = {
      ...entry(),
      modelName: 'tool_search',
    };
    const factory = new ToolCallContextFactory({
      activation: activation(),
      signal: () => new AbortController().signal,
      deferredTools: (snapshot) => ({
        list: () => snapshot.deferredTools(),
        load: () => ({ loaded: [], unknown: [] }),
      }),
    });

    const context = factory.create(searchEntry, 'search-1', () => undefined, early);
    expect(context.deferredTools?.list().map((tool) => tool.modelName)).toEqual([
      'mcp__srv__early',
    ]);
    expect(context.deferredTools?.list()).not.toEqual(late.deferredTools());
  });

  it('reads the current model for each call without rebuilding activation state', () => {
    let model = 'provider::v1';
    const activationContext = activation({ currentModel: () => model });
    const factory = new ToolCallContextFactory({
      activation: activationContext,
      signal: () => new AbortController().signal,
    });

    expect(factory.create(entry(), 'call-1', () => undefined).currentModel).toBe('provider::v1');
    model = 'provider::v2';
    expect(factory.create(entry(), 'call-2', () => undefined).currentModel).toBe('provider::v2');
  });

  it('grants a complete browser runtime only to browser entries', () => {
    const browser = { domain: 'browser' } as ToolActivationContext['browser'];
    const factory = new ToolCallContextFactory({
      activation: activation({ resourceIds: { browserId: 'browser-1' }, browser }),
      signal: () => new AbortController().signal,
    });

    const context = factory.create(entry('browser'), 'call-browser', () => undefined);
    expect(context.resourceIds.browserId).toBe('browser-1');
    expect(context.browser).toBe(browser);
  });

  it.each([
    ['missing browser ID', { browser: { domain: 'browser' } }, /complete browser runtime/],
    ['missing browser runtime', { resourceIds: { browserId: 'browser-1' } }, /complete browser runtime/],
  ])('rejects a browser entry with %s before SkillContext construction', (_label, overrides, error) => {
    const factory = new ToolCallContextFactory({
      activation: activation(overrides as Partial<ToolActivationContext>),
      signal: () => new AbortController().signal,
    });
    expect(() => factory.create(entry('browser'), 'call-browser', () => undefined)).toThrow(error);
  });

  it('does not leak the browser runtime into local entries', () => {
    const factory = new ToolCallContextFactory({
      activation: activation({
        resourceIds: { browserId: 'browser-1' },
        browser: { domain: 'browser' } as ToolActivationContext['browser'],
      }),
      signal: () => new AbortController().signal,
    });

    const context = factory.create(entry('local'), 'call-local', () => undefined);
    expect(context.browser).toBeUndefined();
  });
});
