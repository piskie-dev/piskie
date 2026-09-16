import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ConversationEntry } from '../../../shared/types/index.js';
import { createTranscriptStore } from '../../../src/domains/transcript/transcript-store';
import { createFileChangesResource } from '../../../src/features/console/data/useFileChanges';
import { createWorker, pageSource, user, write } from '../../../src/features/console/data/__tests__/fileChanges.fixtures';
import { ConversationStore } from '../../agent-runs/conversation-store.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { getStandaloneToolCatalog } from '../../tools/index.js';
import type { FinalToolFace } from '../../tools/catalog.js';
import { AgentRuntime } from '../agent-runtime.js';
import { SubagentModule } from '../modules/subagent.module.js';
import type { ToolActivationContext } from '../tool-call/context-builder.js';
import { RuntimeTraceWriter } from '../tracing/runtime-trace-writer.js';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sample-app', on: () => undefined } }));
vi.mock('../../services/paths.service.js', () => ({ pathsService: {
  getDefaultWorkspaceDir: () => '/tmp/sample-workspace', getTempDir: () => '/tmp/sample-temp',
} }));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: { raise: vi.fn(), recover: vi.fn() },
}));
vi.mock('../../agent-runs/compaction-archive.js', () => ({
  compactionArchive: { saveCompaction: vi.fn(), loadCompactions: vi.fn(() => []) },
}));

class MainRuntime extends AgentRuntime {
  initializeTools(): void {
    // Use the real context and tool pipeline without starting external services.
    const setup = this as unknown as {
      createToolContext(): ToolActivationContext;
      createToolFace(activation: ToolActivationContext): FinalToolFace;
    };
    const activation = setup.createToolContext();
    this.initToolExecution(getStandaloneToolCatalog(), setup.createToolFace(activation), activation);
  }
}

class WaitingWorker extends AgentRuntime {
  protected override ensurePump(): void {}

  async consume(): Promise<void> {
    await this.applyEventBatch(this.takeEvents());
    this.context.flush();
  }
}

async function settlePump(runtime: AgentRuntime): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    await new Promise<void>((done) => setImmediate(done));
    if (!runtime.isPumping) return;
  }
  throw new Error('Sample pump did not settle');
}

it.each([
  { name: 'the resend turn for distinct dispatch times', resendAt: 200, ambiguous: false },
  { name: 'the established execution turn for indistinguishable sends', resendAt: 100, ambiguous: true },
])('keeps interrupted and resent changes reviewable in $name', async ({ resendAt, ambiguous }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sample-file-delivery-'));
  const store = new ConversationStore(root);
  const records = new Map<string, ConversationEntry[]>();
  const transcript = createTranscriptStore(pageSource(records));
  const observe = store.subscribeAppends(({ agentId, index, entry }) => {
    const entries = records.get(agentId) ?? [];
    entries[index] = entry;
    records.set(agentId, entries);
    transcript.applyConversation({ agentId, index, entry });
  });
  const baseline = fakeAgentInference();
  let requests = 0;
  const message = 'Update the example containing </agent_input>.';
  const inference = fakeAgentInference({ invoke: async (request, options) => {
    requests += 1;
    const response = await baseline.invoke(request, options);
    return { ...response, content: requests % 2 === 1
      ? [{ type: 'tool_use' as const, id: `send-${requests}`, name: 'send_event', input: {
          type: 'message', targetId: 'sample-worker', message,
        } }]
      : [{ type: 'text' as const, text: 'Sample reply.' }] };
  } });
  const spec = {
    name: 'sample-director', role: 'director' as const, modules: ['subagent'],
    tools: { customTools: ['send_event'], sdkGroups: [] }, buildSystemPrompt: () => 'Sample instructions.',
  };
  const options = {
    mainAgentId: 'sample-main', initialModel: 'sample::model', initialApprovalMode: 'auto',
    runConfig: { name: 'Sample task', description: '', promptTemplate: '' },
  };
  const main = new MainRuntime({ id: 'sample-main', spec, options, inference, conversationStore: store });
  const worker = new WaitingWorker({
    id: 'sample-worker', spec: { ...spec, name: 'sample-worker', role: 'worker', modules: [] },
    options: { ...options, subagentConfig: { type: 'local-worker', subject: 'Sample task', prompt: 'Inspect the sample.', skills: [] } },
    inference: baseline, conversationStore: store,
  });
  const module = main.getModule<SubagentModule>('subagent')!;
  module.getSubagents().set(worker.id, worker);
  vi.spyOn(RuntimeTraceWriter.prototype, 'recordLifecycle').mockImplementation(() => undefined);
  main.initializeTools();
  for (const entry of [user('creation-turn'), ...createWorker(worker.id)]) {
    main.appendConversationEntry(entry);
  }
  const resource = createFileChangesResource(transcript, main.id, true);
  const unsubscribe = resource.subscribe(vi.fn());
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    vi.setSystemTime(100);
    main.post({ source: 'user', content: 'Sample second request.' });
    await settlePump(main);
    expect(requests).toBe(2);
    expect(worker.getMailbox().snapshot()).toHaveLength(1);
    await worker.interrupt();
    expect(worker.getMailbox().snapshot()).toHaveLength(0);
    expect(records.get(worker.id) ?? []).toHaveLength(0);

    vi.setSystemTime(resendAt);
    main.post({ source: 'user', content: 'Sample third request.' });
    await settlePump(main);
    expect(requests).toBe(4);
    expect(worker.getMailbox().snapshot()[0]?.timestamp.getTime()).toBe(resendAt);
    vi.setSystemTime(1000);
    await worker.consume();
    expect(records.get(worker.id)).toMatchObject([{
      t: 'msg', role: 'user', ts: 1000,
      content: `<agent_input source="parent" ts="${new Date(resendAt).toISOString()}">\nUpdate the example containing <\\/agent_input>.\n</agent_input>`,
    }]);
    for (const entry of write('continued', 'sample', '/workspace/sample.txt', 1001)) {
      worker.appendConversationEntry(entry);
    }
    const mainEntries = records.get(main.id)!;
    expect(mainEntries.filter((entry) => entry.t === 'tool' && entry.toolUseId.startsWith('send-') && entry.ok)).toHaveLength(2);
    const turns = mainEntries.filter((entry) => entry.t === 'msg' && entry.role === 'user');
    const latest = turns.at(-1)!;
    expect(latest.t === 'msg' && latest.content).toBe('Sample third request.');
    expect(resource.getSnapshot().totals).toEqual({ filesChanged: 1, added: 1, removed: 0 });
    expect(resource.getSnapshot().rounds).toMatchObject([{
      id: ambiguous ? 'creation-turn' : latest.t === 'msg' ? latest.id : '',
      files: [{ records: [{ node: { id: 'continued' } }] }],
    }]);
  } finally {
    unsubscribe();
    observe();
    transcript.close();
    module.getSubagents().clear();
    await main.destroy();
    await worker.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
});
