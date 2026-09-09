import { describe, expect, it, vi } from 'vitest';
import { ToolCallContextFactory, type ToolActivationContext } from '../../agent/tool-call/context-builder.js';
import { ToolCatalog } from '../catalog.js';
import { ToolCoordinator } from '../coordinator.js';
import { WebSearchTool } from './web-search.tool.js';
import { BASIC_SEARCH_CAPABILITIES, type SearchPort } from '../../../shared/types/web-search.js';
import { searchError } from '../../search/errors.js';

function fixture(search: SearchPort['search'], signal = new AbortController().signal) {
  const activation: ToolActivationContext = {
    agentType: 'worker', agentSpec: 'local-worker', agentId: 'sample-worker', mainAgentId: 'sample-main',
    runConfig: { name: 'sample', description: '', promptTemplate: '' }, resourceIds: {},
    currentModel: () => 'sample::model', workspace: { dir: '/workspace', tempDir: '/tmp/sample-run' },
    modes: { modeId: () => 'normal', approvalMode: () => 'confirm' }, post: () => true, search: { search, capabilities: BASIC_SEARCH_CAPABILITIES },
  };
  const catalog = new ToolCatalog();
  catalog.register(new WebSearchTool(), 'builtin');
  const snapshot = catalog.snapshot({ scope: 'subagent', agentType: 'worker', customTools: ['web_search'],
    exposedSkillFunctions: [], excluded: new Set(), domains: new Set(['local']) });
  const observer = { start: vi.fn(), finish: vi.fn() };
  const coordinator = new ToolCoordinator({ contexts: new ToolCallContextFactory({ activation, signal: () => signal }), observer });
  return { observer, run: (input: string | Record<string, unknown>) => coordinator.run({ modelName: 'web_search', callId: 'sample-call',
    rawParams: typeof input === 'string' ? { query: input } : input }, snapshot) };
}

describe('web_search on the built-in tool execution path', () => {
  it('exposes date format instructions without a calendar regex in the model schema', () => {
    const catalog = new ToolCatalog();
    catalog.register(new WebSearchTool(), 'builtin');
    const snapshot = catalog.snapshot({ scope: 'subagent', agentType: 'worker', customTools: ['web_search'],
      exposedSkillFunctions: [], excluded: new Set(), domains: new Set(['local']),
      searchCapabilities: { domains: true, publishedAfter: true, publishedBefore: true } });
    const properties = snapshot.definitions().find((item) => item.name === 'web_search')!.input_schema.properties;
    for (const name of ['publishedAfter', 'publishedBefore']) {
      expect(properties[name]).toMatchObject({ type: 'string', description: expect.stringContaining('YYYY-MM-DD') });
      expect(properties[name]).not.toHaveProperty('pattern');
    }
  });

  it.each([
    ['publishedAfter', '2026/01/01'],
    ['publishedAfter', '2025-02-29'],
    ['publishedBefore', '2026-13-01'],
    ['publishedBefore', 20260101],
  ])('explains the required date format for invalid %s input %s without searching', async (name, value) => {
    const search = vi.fn<SearchPort['search']>();
    const { run } = fixture(search);
    expect(await run({ query: 'sample', [name]: value })).toMatchObject({
      result: { ok: false, text: expect.stringContaining(`${name}: 请按 YYYY-MM-DD 格式填写有效日期。`) },
    });
    expect(search).not.toHaveBeenCalled();
  });

  it('validates input, uses ordinary query admission and delivers evidence with separate diagnostic data', async () => {
    const search = vi.fn<SearchPort['search']>().mockResolvedValue({
      document: { evidence: { kind: 'sources', sources: [{ title: 'Example', url: 'https://example.org', excerpts: ['Evidence'] }] } },
      diagnostics: { providerId: 'parallel', durationMs: 4, sourceCount: 1 },
    });
    const signal = new AbortController().signal;
    const { run, observer } = fixture(search, signal);
    const result = await run('  sample query  ');
    expect(search).toHaveBeenCalledWith({ query: 'sample query' }, { signal, sessionId: 'conversation:sample-main' });
    expect(JSON.stringify(result)).toContain('https://example.org');
    expect(observer.start).toHaveBeenCalledOnce();
    expect(observer.finish).toHaveBeenCalledOnce();
    await run('   ');
    expect(search).toHaveBeenCalledOnce();
  });

  it('returns provider failures as ordinary tool errors', async () => {
    const { run } = fixture(async () => { throw searchError('rate_limited'); });
    expect(await run('sample')).toMatchObject({ result: { ok: false, text: searchError('rate_limited').message } });
  });

  it('passes filters through ordinary input validation and keeps the caller signal', async () => {
    const search = vi.fn<SearchPort['search']>().mockResolvedValue({ document: { evidence: { kind: 'sources', sources: [] } },
      diagnostics: { providerId: 'exa', durationMs: 1, sourceCount: 0 } });
    const signal = new AbortController().signal;
    const { run } = fixture(search, signal);
    const request = { query: 'sample', domains: { mode: 'include', values: ['example.org'] },
      publishedAfter: '2026-01-01', publishedBefore: '2026-02-01' };
    expect(await run(request)).toMatchObject({ result: { ok: true } });
    expect(search).toHaveBeenCalledWith(request, { signal, sessionId: 'conversation:sample-main' });
    await run({ ...request, publishedBefore: '2025-01-01' });
    expect(search).toHaveBeenCalledOnce();
  });

  it('preserves the original cancellation reason at the tool boundary', async () => {
    const controller = new AbortController();
    const reason = new Error('sample interruption');
    const tool = new WebSearchTool();
    const context = { signal: controller.signal, mainAgentId: 'sample-main', search: {
      search: async () => { controller.abort(reason); throw new Error('upstream cancellation'); },
    } };
    await expect(tool.execute({ query: 'sample' }, context as never)).rejects.toBe(reason);
  });
});
