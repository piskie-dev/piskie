import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sample-profile', on: vi.fn() } }));
vi.mock('../../services/paths.service.js', () => ({
  pathsService: {
    getDefaultWorkspaceDir: () => '/tmp/sample-workspace',
    getTempDir: () => '/tmp/sample-runtime',
    ensureWorkspace: vi.fn(),
  },
}));
vi.mock('../../agent-runs/compaction-archive.js', () => ({
  compactionArchive: { saveCompaction: vi.fn(), loadCompactions: vi.fn(() => []) },
}));

import type { AgentInputEvent, UserMessageInput } from '../../../shared/types/index.js';
import type { ConversationEntry, UserMsgEntry } from '../../../shared/types/agent-control.js';
import { AgentRuntime } from '../agent-runtime.js';
import type { AgentConversationContext } from '../context/agent-conversation-context.js';
import { ConversationStore } from '../../agent-runs/conversation-store.js';
import { DirectorRole } from '../roles/director.role.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { projectConversationNodes } from '../../../src/domains/transcript/project-entry.js';
import { TranscriptProjector } from '../../../src/domains/transcript/projector.js';

const files = [
  { name: 'sample.csv', path: '/workspace/sample files/sample.csv' },
  { name: 'sample.zip', path: '/workspace/sample files/sample.zip' },
];
const image = { data: 'c2FtcGxl', media_type: 'image/png' };
let directory: string;
let store: ConversationStore;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'sample-attachments-'));
  store = new ConversationStore(directory);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function harness(role: 'director' | 'worker' = 'director', owner = store) {
  const id = role === 'director' ? 'sample-main' : 'sample-worker';
  const runtime = new AgentRuntime({
    id,
    spec: { name: `sample-${role}`, role, modules: [], tools: { sdkGroups: [], customTools: [] }, buildSystemPrompt: () => 'Sample instructions.' },
    inference: fakeAgentInference(), conversationStore: owner,
    options: {
      mainAgentId: 'sample-main', initialModel: 'sample::model', initialApprovalMode: 'confirm',
      runConfig: { name: 'Sample task', description: '', promptTemplate: '' },
      ...(role === 'worker' ? { subagentConfig: { type: 'local-worker', subject: 'Sample task', prompt: 'Sample task', skills: [] } } : {}),
    },
  });
  const context = (runtime as unknown as { context: AgentConversationContext }).context;
  return {
    runtime, context,
    apply: (event: AgentInputEvent) => (runtime as unknown as { applyEvents(events: AgentInputEvent[]): void | Promise<void> }).applyEvents([event]),
  };
}
function event(input: UserMessageInput, images?: typeof image[]): AgentInputEvent {
  return { id: 'sample-input', timestamp: new Date(), source: 'user', content: input.text, files: input.files ? [...input.files] : undefined, images };
}
function nodeFacts(entries: readonly ConversationEntry[]) {
  return projectConversationNodes(entries).map((node) => {
    if (node.kind === 'user') return { kind: node.kind, text: node.text, files: node.files, images: node.images };
    if (node.kind === 'tool') return { kind: node.kind, files: node.files, media: node.media, detail: node.detail?.() };
    return { kind: node.kind };
  });
}
async function modelMessages(h: ReturnType<typeof harness>) {
  return (await h.context.getMessagesForAI({
    systemPrompt: 'Sample instructions.', tools: [], model: h.runtime.currentTarget,
    reasoningOverride: h.runtime.reasoningOverride, promptCacheKey: h.runtime.id,
  })).messages;
}

describe('structured user attachments', () => {
  it.each(['director', 'worker'] as const)('persists and replays original text, files and images for %s input', async (role) => {
    const h = harness(role);
    const live: ConversationEntry[] = [];
    const projector = new TranscriptProjector();
    projector.reset(0, []);
    const unsubscribe = store.subscribeAppends(({ entry, index }) => { live.push(entry); projector.apply(index, entry); });
    const inputs = [
      { text: '', files },
      { text: '  Inspect the sample\nKeep the spacing.  ', files },
      { text: 'Use the sample image and files.', files },
    ];
    for (const [index, input] of inputs.entries()) await h.apply(event(input, index === 2 ? [image] : undefined));
    expect(live).toHaveLength(3);
    unsubscribe();
    const disk = new ConversationStore(directory).read('sample-main', h.runtime.id);
    expect(live).toEqual(disk);
    expect(disk.map((entry) => (entry as UserMsgEntry).metadata?.userInput)).toEqual(inputs);
    expect(nodeFacts(disk)).toEqual(inputs.map((input, index) => ({
      kind: 'user', ...input,
      images: index === 2 ? [expect.objectContaining({ kind: 'file' })] : undefined,
    })));
    expect(projector.snapshot().nodes.map((node) => node.kind === 'user' && ({ text: node.text, files: node.files })))
      .toEqual(inputs);
    expect(readFileSync(store.getConversationPath('sample-main', h.runtime.id), 'utf8')).toContain('"userInput"');
    const before = await modelMessages(h);
    for (const [index, message] of before.entries()) {
      const model = JSON.stringify(message.content);
      expect(model).toContain(files[0].path);
      expect(model).toContain(files[1].path);
      if (inputs[index].text) expect(model).toContain(JSON.stringify(inputs[index].text).slice(1, -1));
      expect(message).not.toHaveProperty('metadata');
    }
    expect(before).toHaveLength(3);
    const restored = harness(role, new ConversationStore(directory));
    const restoreMessage = vi.spyOn(restored.context, 'addUserMessage');
    await restored.runtime.replayConversation(disk);
    expect(await modelMessages(restored)).toEqual(before);
    expect(nodeFacts(new ConversationStore(directory).read('sample-main', h.runtime.id))).toEqual(nodeFacts(live));
    expect(restoreMessage.mock.calls.map(([, , details]) => details?.metadata?.userInput)).toEqual(inputs);
  });

  it.each(['director', 'worker'] as const)('keeps attachment-only approval feedback for %s', async (role) => {
    const h = harness(role);
    const post = vi.spyOn(h.runtime, 'post').mockReturnValue(true);
    const pending = h.runtime.handleApprovalRequest({
      id: 'sample-approval', agentId: h.runtime.id, mainAgentId: 'sample-main',
      toolName: 'sample-tool', params: {}, description: 'Sample approval', category: 'system', timestamp: new Date(),
    });
    const decision = { callId: 'sample-approval', decision: 'deny' as const, feedback: '', files, images: [image] };
    expect(h.runtime.respondToApproval(decision)).toBe(true);
    await expect(pending).resolves.toEqual(decision);
    const submitted = post.mock.calls[0][0];
    expect(submitted).toMatchObject({ content: '', files, images: [image], source: 'user' });
    await h.apply(submitted as AgentInputEvent);
    h.context.flush();
    expect(nodeFacts(store.read('sample-main', h.runtime.id))[0]).toMatchObject({ text: '', files });
    expect(JSON.stringify((await modelMessages(h))[0].content)).toContain(files[0].path);
    post.mockRestore();
  });

  it('preserves MCP question attachments while passing only answers to the continuation', async () => {
    const h = harness();
    h.context.addAssistantMessage([{ type: 'tool_use', id: 'sample-mcp', name: 'mcp__sample__ask', input: {} }]);
    const pending = { toolUseId: 'sample-mcp', continuation: { questions: [{ question: 'Sample question?' }] }, answers: undefined as string[] | undefined };
    (h.runtime as unknown as { pendingToolContinuation: unknown }).pendingToolContinuation = pending;
    await h.apply({ ...event({ text: 'Sample answer', files }, [image]), uiSubmission: { kind: 'ask_user_answer', answers: ['Sample answer'] } });
    expect(pending.answers).toEqual(['Sample answer']);
    h.context.flush();
    const input = store.read('sample-main', h.runtime.id).find((entry) => entry.t === 'msg' && entry.role === 'user') as UserMsgEntry;
    expect(input.metadata?.userInput).toEqual({ text: 'Sample answer', files });
    expect(JSON.stringify(input.content)).toContain(files[0].path);
  });

  it('uses the same owner for the initial message', async () => {
    const h = harness();
    await new DirectorRole().onStart(h.runtime, {
      mainAgentId: h.runtime.id, files, images: [image],
      runConfig: { name: 'sample.csv', description: 'sample.csv', promptTemplate: '' },
    });
    const [entry] = store.read('sample-main', h.runtime.id) as UserMsgEntry[];
    expect(entry.subtype).toBe('system_task');
    expect(entry.metadata?.userInput).toEqual({ text: '', files });
    expect(nodeFacts([entry])[0]).toMatchObject({ kind: 'user', text: '', files });
    expect(JSON.stringify((await modelMessages(h))[0].content)).toContain(files[0].path);
  });

  it('keeps ordinary marker-like text verbatim', async () => {
    const h = harness();
    const text = '  Example text\n附件文件路径：\n- /workspace/example.txt\nMore user text.  ';
    await h.apply(event({ text }));
    h.context.flush();
    expect(nodeFacts(store.read('sample-main', h.runtime.id))).toEqual([{ kind: 'user', text, files: undefined, images: undefined }]);
    expect((await modelMessages(h))[0].content).toBe(text);
  });

  it('keeps paired answers in the tool entry with structured display metadata', async () => {
    const h = harness('worker');
    h.context.addAssistantMessage([{ type: 'tool_use', id: 'sample-ask', name: 'ask_user', input: { questions: [{ question: 'Sample question?' }] } }]);
    const input = { text: 'Sample answer', files };
    await h.apply({ ...event(input, [image]), uiSubmission: { kind: 'ask_user_answer', answers: ['Sample answer'] } });
    h.context.flush();
    const disk = store.read('sample-main', h.runtime.id);
    const answer = disk.find((entry) => entry.t === 'tool');
    expect(answer).toMatchObject({ metadata: { userInput: input }, artifacts: [{ kind: 'ask_user_answers', payload: { answers: ['Sample answer'] } }] });
    const node = projectConversationNodes(disk).find((cell) => cell.kind === 'tool')!;
    expect(node.files).toEqual(files);
    expect(JSON.stringify(node.detail?.())).toContain('Sample answer');
    expect(JSON.stringify(node.detail?.())).not.toContain(files[0].path);
    const before = await modelMessages(h);
    expect(JSON.stringify(before)).toContain(files[0].path);
    expect(JSON.stringify(before)).not.toContain('userInput');
    const restored = harness('worker', new ConversationStore(directory));
    await restored.runtime.replayConversation(disk);
    expect(await modelMessages(restored)).toEqual(before);
    expect(nodeFacts(new ConversationStore(directory).read('sample-main', h.runtime.id))).toEqual(nodeFacts(disk));
  });
});
