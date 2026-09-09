import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../agent-runtime.js';
import { BUILTIN_AGENT_SPECS } from '../specs/builtin/index.js';
import { ToolCallContextFactory, type ToolActivationContext } from '../tool-call/context-builder.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import type { CatalogSnapshot, FinalToolFace, ToolCatalog } from '../../tools/catalog.js';
import { getStandaloneToolCatalog } from '../../tools/index.js';
import { ToolCoordinator } from '../../tools/coordinator.js';
import { BASIC_SEARCH_CAPABILITIES, type SearchCapabilities, type SearchPort } from '../../../shared/types/web-search.js';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/example-app', on: vi.fn() } }));
vi.mock('../../services/paths.service.js', () => ({ pathsService: {
  getDefaultWorkspaceDir: () => '/workspace', getTempDir: () => '/tmp/example-run',
} }));

describe('runtime search port binding', () => {
  it.each(['director', 'system-chat', 'local-worker', 'browser-worker'])('grants web_search to %s using the application port', async (name) => {
    const spec = BUILTIN_AGENT_SPECS.find((item) => item.name === name)!;
    const search = vi.fn<SearchPort['search']>().mockResolvedValue({ document: { evidence: { kind: 'text', text: 'Sample evidence' } },
      diagnostics: { providerId: 'parallel', durationMs: 1 } });
    for (const isResume of [false, true]) {
      const worker = spec.role === 'worker';
      let capabilities: SearchCapabilities = BASIC_SEARCH_CAPABILITIES;
      const runtime = new AgentRuntime({
        id: worker ? 'sample-worker' : 'sample-main', spec: { ...spec, modules: [] },
        inference: fakeAgentInference(), conversationStore: { append: vi.fn() } as never,
        onStateChange: vi.fn(), options: { mainAgentId: 'sample-main', initialModel: 'sample::model', isResume,
          search: { search, get capabilities() { return capabilities; } },
          runConfig: { name: 'Sample', description: '', promptTemplate: '' },
          subagentConfig: { subject: 'Sample', taskIds: ['sample-task'], prompt: 'Search sample evidence', mode: 'local', skills: [] },
        },
      });
      const internal = runtime as unknown as { createToolContext(): ToolActivationContext;
        toolCatalog: ToolCatalog; toolFace: FinalToolFace;
        captureCatalogSnapshot(): CatalogSnapshot; getModelBoundaryRevision(): number };
      internal.toolCatalog = getStandaloneToolCatalog();
      internal.toolFace = { scope: worker ? 'subagent' : 'main', agentType: worker ? 'worker' : 'main',
        customTools: spec.tools.customTools, exposedSkillFunctions: [], excluded: new Set(), domains: new Set(['local', 'browser']) };
      const activation = internal.createToolContext();
      expect(activation.search?.search).toBe(search);
      const signal = new AbortController().signal;
      const coordinator = new ToolCoordinator({ contexts: new ToolCallContextFactory({ activation, signal: () => signal }),
        observer: { start: vi.fn(), finish: vi.fn() } });
      const snapshot = internal.captureCatalogSnapshot();
      const fields = (catalog: CatalogSnapshot) => Object.keys(catalog.definitions().find((item) => item.name === 'web_search')!.input_schema.properties);
      expect(fields(snapshot)).toEqual(['query']);
      const revision = internal.getModelBoundaryRevision();
      capabilities = { domains: true, publishedAfter: true, publishedBefore: false };
      expect(internal.getModelBoundaryRevision()).toBe(revision + 1);
      expect(fields(internal.captureCatalogSnapshot())).toEqual(['query', 'domains', 'publishedAfter']);
      capabilities = { ...capabilities, publishedBefore: true };
      expect(internal.getModelBoundaryRevision()).toBe(revision + 2);
      expect(fields(internal.captureCatalogSnapshot())).toEqual(['query', 'domains', 'publishedAfter', 'publishedBefore']);
      expect(internal.getModelBoundaryRevision()).toBe(revision + 2);
      expect(fields(snapshot)).toEqual(['query']);
      expect(await coordinator.run({ modelName: 'web_search', rawParams: { query: 'sample' }, callId: 'sample-search' }, snapshot))
        .toMatchObject({ result: { ok: true, text: 'Sample evidence' } });
      expect(search).toHaveBeenLastCalledWith({ query: 'sample' }, { signal, sessionId: 'conversation:sample-main' });
    }
  });
});
