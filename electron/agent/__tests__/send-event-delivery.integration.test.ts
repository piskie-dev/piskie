import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../shared/types/index.js';
import { ConversationStore } from '../../agent-runs/conversation-store.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { SendEventTool } from '../../tools/agent/send-event.tool.js';
import type { ToolContext } from '../../tools/types.js';
import { AgentRuntime } from '../agent-runtime.js';
import { SubagentModule } from '../modules/subagent.module.js';
import { ToolContextBuilder } from '../tool-context.js';
import { RuntimeTraceWriter } from '../tracing/runtime-trace-writer.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sample-app', on: () => undefined },
}));
vi.mock('../../services/paths.service.js', () => ({
  pathsService: {
    getDefaultWorkspaceDir: () => '/tmp/sample-workspace',
    getTempDir: () => '/tmp/sample-runtime',
  },
}));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: { raise: vi.fn(), recover: vi.fn() },
}));
vi.mock('../../agent-runs/compaction-archive.js', () => ({
  compactionArchive: { saveCompaction: vi.fn(), loadCompactions: vi.fn(() => []) },
}));

class DeliveryRuntime extends AgentRuntime {
  // Consume real mailbox events explicitly, without starting a model turn.
  protected override ensurePump(): void {}

  consumePending(): void | Promise<void> {
    return this.applyEventBatch(this.takeEvents());
  }

  async messagesForAI(): Promise<Message[]> {
    this.context.flush();
    const { messages } = await this.context.getMessagesForAI({
      systemPrompt: 'Sample instructions.',
      tools: [],
      model: this.currentTarget,
      reasoningOverride: this.reasoningOverride,
      promptCacheKey: this.id,
    });
    return messages;
  }
}

const roots: string[] = [];
const modules: SubagentModule[] = [];

afterEach(async () => {
  for (const module of modules.splice(0)) {
    module.getSubagents().clear();
    await module.onDestroy();
  }
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function buildRuntime(store: ConversationStore, worker = false, withSubagents = false): DeliveryRuntime {
  return new DeliveryRuntime({
    id: worker ? 'sample-worker' : 'sample-main',
    spec: {
      name: worker ? 'sample-worker' : 'sample-director',
      role: worker ? 'worker' : 'director',
      modules: withSubagents ? ['subagent'] : [],
      tools: { sdkGroups: [], customTools: ['send_event'] },
      buildSystemPrompt: () => 'Sample instructions.',
    },
    inference: fakeAgentInference(),
    conversationStore: store,
    options: {
      mainAgentId: 'sample-main',
      initialModel: 'sample-provider::sample-model',
      runConfig: { name: 'Sample task', description: '', promptTemplate: '' },
      ...(worker && {
        subagentConfig: { type: 'local-worker', subject: 'Sample task', prompt: 'Inspect the sample.', skills: [] },
      }),
    },
  });
}

async function createHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sample-event-delivery-'));
  roots.push(root);
  const store = new ConversationStore(root);
  const main = buildRuntime(store, false, true);
  const worker = buildRuntime(store, true);
  const module = main.getModule<SubagentModule>('subagent')!;
  modules.push(module);
  module.getSubagents().set(worker.id, worker);
  vi.spyOn(RuntimeTraceWriter.prototype, 'recordLifecycle').mockImplementation(() => undefined);
  return { root, store, main, worker, module };
}

async function expectPersistedAndRestored(
  root: string,
  runtime: DeliveryRuntime,
  text: string,
  worker = false,
) {
  expect(await runtime.messagesForAI()).toContainEqual(expect.objectContaining({ role: 'user', content: text }));

  const reopened = new ConversationStore(root);
  const entries = reopened.read(runtime.mainAgentId, runtime.id);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    t: 'msg', role: 'user', content: text,
    subtype: worker ? 'system_event' : 'subagent_notification',
  });

  const restored = buildRuntime(reopened, worker);
  await restored.replayConversation(entries);
  expect(await restored.messagesForAI()).toContainEqual(expect.objectContaining({ role: 'user', content: text }));
  expect(reopened.read(runtime.mainAgentId, runtime.id)).toEqual(entries);
}

describe('send_event delivery to AI context and conversation history', () => {
  it('delivers a long parent message through the module as text and restores it intact', async () => {
    const { root, main, worker, module } = await createHarness();
    const message = 'Sample instructions: retain spacing  and Unicode 示例.\n'.repeat(80) + 'Final requirement.';
    const builder = new ToolContextBuilder();
    const setEvents = vi.spyOn(builder, 'setEvents');
    module.contributeTools(builder);
    const events = setEvents.mock.calls[0]![0];

    const output = await new SendEventTool().execute(
      { type: 'message', targetId: worker.id, message, summary: 'Sample preview.' },
      { agentId: main.id, mainAgentId: main.id, agentType: 'main', events } as ToolContext,
    );

    expect(message.length).toBeGreaterThan(1000);
    expect(output.ok).toBe(true);
    const [event] = worker.getMailbox().snapshot();
    expect(event).toMatchObject({ source: 'parent', content: message });
    await worker.consumePending();
    const text = `<agent_input source="parent" ts="${event!.timestamp.toISOString()}">\n${message}\n</agent_input>`;
    await expectPersistedAndRestored(root, worker, text, true);
  });

  it.each(['message', 'completed', 'failed', 'user_stopped', 'need_user_action'] as const)(
    'delivers the complete long %s body to the parent and restores it with its event type',
    async (type) => {
      const { root, main, worker, module } = await createHarness();
      const message = 'Sample result: retain spacing  and Unicode 示例.\n'.repeat(80) + 'Final finding.';
      const declareTerminal = vi.fn();
      const output = await new SendEventTool().execute(
        { type, message, summary: 'Sample preview.' },
        {
          agentId: worker.id,
          mainAgentId: main.id,
          agentType: 'worker',
          events: {
            allowedTargets: () => [main.id],
            send: () => false,
            notifyParent: module.createSubagentNotificationHandler(worker.id),
          },
          declareTerminal,
        } as unknown as ToolContext,
      );

      expect(message.length).toBeGreaterThan(1000);
      expect(output.ok).toBe(true);
      const [event] = main.getMailbox().snapshot();
      expect(event).toMatchObject({
        source: 'subagent',
        content: { subagentId: worker.id, type, text: message },
        priority: type === 'need_user_action' ? 'high' : 'normal',
        metadata: { notificationType: type, subagentId: worker.id },
      });
      await main.consumePending();
      const text = `<subagent_event id="${worker.id}" type="${type}" ts="${event!.timestamp.toISOString()}">\n${message}\n</subagent_event>`;
      await expectPersistedAndRestored(root, main, text);
      if (type === 'completed' || type === 'failed' || type === 'user_stopped') {
        expect(declareTerminal).toHaveBeenCalledWith(type);
      } else {
        expect(declareTerminal).not.toHaveBeenCalled();
      }
    },
  );
});
