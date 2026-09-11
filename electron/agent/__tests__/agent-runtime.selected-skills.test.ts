import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const environment = vi.hoisted(() => ({ profile: '', workspace: '', temp: '' }));
vi.mock('electron', () => ({ app: { getPath: () => environment.profile, on: vi.fn() } }));
vi.mock('../../services/paths.service.js', () => ({ pathsService: {
  getDefaultWorkspaceDir: () => environment.workspace,
  getTempDir: () => environment.temp,
  ensureTempDir: vi.fn(async () => undefined),
  ensureWorkspace: vi.fn(async () => undefined),
} }));

import { AgentRuntime } from '../agent-runtime.js';
import { SubagentModule } from '../modules/subagent.module.js';
import { AgentConversationContext } from '../context/agent-conversation-context.js';
import { ConversationStore } from '../../agent-runs/conversation-store.js';
import { CompactionArchive, compactionArchive } from '../../agent-runs/compaction-archive.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { getStandaloneToolCatalog } from '../../tools/index.js';
import { z } from '../../tools/params.js';
import type { AgentSpec } from '../specs/spec.js';
import type { SkillCatalogPort } from '../../core/pilot/pilot-manager.js';
import type { AgentInputEvent, Message } from '../../../shared/types/index.js';
import type { UserMsgEntry } from '../../../shared/types/agent-control.js';
import type { AgentInferencePort } from '../../inference/application/agent-inference-port.js';
import type { ToolSuspensionContinuation } from '../../tools/types.js';
import { agentControlSnapshot, agentRunSnapshot } from '../../capabilities/agent-runs/public-agent-run-view.js';

const LOADED = '以下用户选择的技能已完整加载，请使用这些技能完成任务。';
let root: string;
let store: ConversationStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'selected-skills-'));
  environment.profile = path.join(root, 'profile');
  environment.workspace = path.join(root, 'default-workspace');
  environment.temp = path.join(root, 'temp');
  await fs.mkdir(environment.profile);
  await fs.mkdir(environment.workspace);
  await fs.writeFile(path.join(environment.profile, 'AGENTS.md'), 'Sample global rules.');
  store = new ConversationStore(environment.profile);
  vi.spyOn(compactionArchive, 'archiveOriginalMessages').mockImplementation((...args) =>
    new CompactionArchive(environment.profile).archiveOriginalMessages(...args)
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function catalog() {
  return {
    listManagedSkills: vi.fn(async () => ['sample-guide', 'sample-actions', 'broken-guide'].map((name) => ({
      name, description: 'Sample skill', scope: 'user' as const, enabled: true,
      executionType: 'knowledge' as const, path: path.join(root, name),
    }))),
    classifySkill: vi.fn(async () => 'standard' as const),
    getSkillDocs: vi.fn(async (name: string) => {
      if (name === 'broken-guide') throw new Error('Sample teaching read failed');
      return `# ${name}\nComplete sample teaching for ${name}.\nEnd of teaching.`;
    }),
    getSkillResourceRoot: vi.fn(() => undefined),
    getLoadedSkillModule: vi.fn((name: string) => name === 'sample-actions' ? {
      functions: { produce: { description: 'Produce a sample result', params: z.object({ text: z.string() }) } },
      provenance: { entryPoint: 'skill_call' },
    } : undefined),
    getToolCatalog: () => getStandaloneToolCatalog(),
    getDirectSkillToolNames: () => [],
  };
}

function harness(options: {
  role?: 'director' | 'worker'; skills?: string[]; text?: string; isResume?: boolean;
  workspace?: string; runtimeWorkspace?: string; inference?: AgentInferencePort;
  images?: Array<{ data: string; media_type: string }>;
} = {}) {
  const role = options.role ?? 'director';
  const skills = catalog();
  const inference = options.inference ?? fakeAgentInference();
  const invoke = vi.spyOn(inference, 'invoke');
  const spec: AgentSpec = {
    name: `${role}-sample`, role, modules: [],
    tools: { sdkGroups: [], customTools: [] },
    buildSystemPrompt: () => 'Sample system rules.',
  };
  const runtime = new AgentRuntime({
    id: role === 'director' ? 'sample-main' : 'sample-worker', spec, inference,
    pilotPorts: { skills: skills as unknown as SkillCatalogPort } as never,
    conversationStore: store,
    options: {
      mainAgentId: 'sample-main', initialModel: 'sample::model', isResume: options.isResume,
      runConfig: {
        name: 'Sample task', description: '', promptTemplate: options.text ?? 'Sample task',
        workspace: options.workspace, skills: options.skills,
      },
      workspace: options.runtimeWorkspace,
      images: options.images,
      ...(role === 'worker' ? { subagentConfig: {
        type: 'local-worker', skills: [], subject: 'Sample assignment', taskIds: [], prompt: 'Sample assignment',
      } } : {}),
    },
  });
  vi.spyOn(runtime as unknown as { prepareMcpSession(): Promise<void> }, 'prepareMcpSession')
    .mockResolvedValue(undefined);
  const context = (runtime as unknown as { context: AgentConversationContext }).context;
  return {
    runtime, skills, invoke, context,
    apply: (events: AgentInputEvent[]) => (runtime as unknown as {
      applyEvents(events: AgentInputEvent[]): void | Promise<void>;
    }).applyEvents(events),
  };
}

function event(content: string, skills?: string[]): AgentInputEvent {
  return { id: `sample-event-${Math.random()}`, timestamp: new Date(), source: 'user', content, skills };
}
function text(messages: readonly Message[]): string { return JSON.stringify(messages); }
function userEntries(id: string): UserMsgEntry[] {
  return store.read('sample-main', id).filter((entry): entry is UserMsgEntry => entry.t === 'msg' && entry.role === 'user');
}
async function idle(runtime: AgentRuntime) {
  await vi.waitFor(() => expect(runtime.isPumping).toBe(false));
}

interface PendingContinuation {
  toolUseId: string; toolName: string; continuation: ToolSuspensionContinuation; answers?: string[];
}

describe('user-selected Skill runtime input', () => {
  it('loads complete teaching and function calls before the first model request, preserving image and text history', async () => {
    const image = { data: 'c2FtcGxl', media_type: 'image/png' };
    const h = harness({ skills: ['sample-guide', 'sample-actions'], images: [image] });
    await h.runtime.start();
    await idle(h.runtime);
    const request = h.invoke.mock.calls[0][0];
    expect(text(request.messages)).toContain(LOADED);
    expect(text(request.messages)).toContain('Complete sample teaching for sample-guide.');
    expect(text(request.messages)).toContain('produce(text*)');
    expect(text(request.messages)).toContain('skill_call');
    expect(request.messages[1].content).toEqual(expect.arrayContaining([
      { type: 'image', source: { type: 'base64', ...image } },
      { type: 'text', text: 'Sample task' },
    ]));
    const entry = userEntries(h.runtime.id)[0];
    expect(entry.metadata).toEqual({ skills: ['sample-guide', 'sample-actions'] });
    expect(entry.instructions).toContain(LOADED);
    expect(JSON.stringify(entry.content)).not.toContain(LOADED);
    expect(entry.subtype).toBe('system_task');
    store.writeHeader('sample-main', h.runtime.buildHeader());
    expect(store.readHeader('sample-main')?.runConfig.skills).toEqual(['sample-guide', 'sample-actions']);
  });

  it('accepts a skill-only first task with its original empty body', async () => {
    const h = harness({ text: '', skills: ['sample-guide'] });
    await h.runtime.start();
    await idle(h.runtime);
    expect(text(h.invoke.mock.calls[0][0].messages)).toContain(LOADED);
    expect(userEntries(h.runtime.id)[0]).toMatchObject({ content: '', metadata: { skills: ['sample-guide'] } });
  });

  it.each(['director', 'worker'] as const)('reloads selected teaching for an appended %s task in its actual workspace', async (role) => {
    const workspace = path.join(root, 'sample-project');
    await fs.mkdir(workspace);
    const h = harness({ role, workspace });
    await h.runtime.start();
    await idle(h.runtime);
    h.skills.getSkillDocs.mockResolvedValue('Updated complete sample teaching.');
    if (role === 'worker') {
      const children = new SubagentModule();
      (children as unknown as { subagents: Map<string, AgentRuntime> }).subagents.set(h.runtime.id, h.runtime);
      expect(children.injectEventToSubagent(h.runtime.id, event('', ['sample-guide']))).toBe(true);
    } else {
      h.runtime.post({ source: 'user', content: '', skills: ['sample-guide'] });
    }
    await idle(h.runtime);
    const request = h.invoke.mock.calls.at(-1)![0];
    expect(text(request.messages)).toContain('Updated complete sample teaching.');
    expect(h.skills.listManagedSkills).toHaveBeenLastCalledWith({ scope: 'all', workspaces: [workspace] });
    expect(userEntries(h.runtime.id).at(-1)).toMatchObject({
      content: '', subtype: 'user_input', metadata: { skills: ['sample-guide'] },
    });
  });

  it('reports mixed failures to the model and history, and never declares an all-failed selection loaded', async () => {
    const h = harness({ skills: ['sample-guide', 'missing-guide', 'broken-guide'] });
    await h.runtime.prepare();
    h.context.flush();
    const mixed = userEntries(h.runtime.id)[0];
    expect(mixed.metadata?.skillLoadErrors).toEqual([
      { name: 'missing-guide', error: '当前工作区中未找到已启用的技能' },
      { name: 'broken-guide', error: 'Sample teaching read failed' },
    ]);
    const [success, failures] = mixed.instructions!.split('以下用户选择的技能加载失败：');
    expect(success).toContain(LOADED);
    expect(success).toContain('Complete sample teaching for sample-guide.');
    expect(success).not.toContain('broken-guide');
    expect(failures).toContain('Sample teaching read failed');
    await h.apply([event('', ['broken-guide'])]);
    h.context.flush();
    const failed = userEntries(h.runtime.id).at(-1)!;
    expect(failed.instructions).not.toContain(LOADED);
    expect(text(h.runtime.buildContextSnapshot().messages)).toContain('Sample teaching read failed');
  });

  it('treats text mentions as ordinary input and reloads only new explicit selections', async () => {
    const h = harness();
    await h.runtime.prepare();
    await h.apply([event('/sample-guide'), event('Use sample-guide')]);
    expect(h.skills.getSkillDocs).not.toHaveBeenCalled();
    await h.apply([event('Selected task', ['sample-guide'])]);
    h.skills.getSkillDocs.mockResolvedValue('New version of complete teaching.');
    await h.apply([event('Follow-up task'), event('Select again', ['sample-guide'])]);
    expect(h.skills.getSkillDocs).toHaveBeenCalledTimes(2);
    expect(text(h.runtime.buildContextSnapshot().messages)).toContain('New version of complete teaching.');
  });

  it('waits for skill loading and preserves FIFO across messages arriving during loading', async () => {
    const h = harness();
    await h.runtime.prepare();
    let finish!: (teaching: string) => void;
    h.skills.getSkillDocs.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    h.runtime.post({ source: 'user', content: 'First task', skills: ['sample-guide'] });
    await vi.waitFor(() => expect(h.skills.getSkillDocs).toHaveBeenCalledTimes(1));
    h.runtime.post({ source: 'user', content: 'Second task' });
    expect(h.invoke).not.toHaveBeenCalled();
    finish('Complete delayed teaching.');
    await idle(h.runtime);
    const messages = h.invoke.mock.calls[0][0].messages;
    expect(text(messages)).toContain('Complete delayed teaching.');
    expect(text(messages).indexOf('First task')).toBeLessThan(text(messages).indexOf('Second task'));
  });

  it.each(['ask_user', 'mcp'] as const)('keeps selected tasks separate from pending %s answers', async (kind) => {
    const h = harness();
    await h.runtime.prepare();
    const input = kind === 'ask_user' ? { questions: [{ question: 'Choose a sample', options: [], multiSelect: false }] } : {};
    h.context.addAssistantMessage([{ type: 'tool_use', id: 'sample-call', name: kind === 'ask_user' ? kind : 'mcp_sample', input }]);
    const pending: PendingContinuation = {
      toolUseId: 'sample-call', toolName: 'mcp_sample',
      continuation: { questions: [{ question: 'Choose a sample' }], resume: vi.fn(), cancel: vi.fn() },
    };
    if (kind === 'mcp') (h.runtime as unknown as { pendingToolContinuation: PendingContinuation }).pendingToolContinuation = pending;
    await h.apply([event('New selected task', ['sample-guide'])]);
    expect(pending.answers).toBeUndefined();
    expect(h.context.getAllMessages().flatMap((m) => Array.isArray(m.content) ? m.content : [])
      .filter((block) => block.type === 'tool_result')).toHaveLength(0);
    const answer = { ...event('Sample answer'), uiSubmission: { kind: 'ask_user_answer' as const, answers: ['Sample answer'] } };
    await h.apply([answer]);
    if (kind === 'mcp') expect(pending.answers).toEqual(['Sample answer']);
    else expect(h.context.getAllMessages().flatMap((m) => Array.isArray(m.content) ? m.content : [])
      .some((block) => block.type === 'tool_result')).toBe(true);
    expect(h.skills.getSkillDocs).toHaveBeenCalledTimes(1);
  });

  it('restores the exact model teaching and metadata from disk without reading the skill again', async () => {
    const h = harness({ skills: ['sample-guide', 'broken-guide'] });
    await h.runtime.prepare();
    h.context.flush();
    const entries = store.read('sample-main', h.runtime.id);
    const restored = harness({ isResume: true });
    await restored.runtime.replayConversation(entries);
    await restored.runtime.start();
    await idle(restored.runtime);
    expect(text(restored.invoke.mock.calls[0][0].messages)).toContain('Complete sample teaching for sample-guide.');
    expect(text(restored.invoke.mock.calls[0][0].messages)).toContain('Sample teaching read failed');
    expect(restored.skills.getSkillDocs).not.toHaveBeenCalled();
    expect(userEntries(restored.runtime.id)).toHaveLength(1);
    expect(userEntries(restored.runtime.id)[0].metadata).toEqual((entries[0] as UserMsgEntry).metadata);
  });

  it('keeps unprocessed teaching complete through compaction and actual disk replay', async () => {
    const inference = fakeAgentInference({ contextWindow: () => 200_000 });
    const h = harness({ inference });
    await h.runtime.prepare();
    h.context.commitSuccessfulRequest(h.context.captureRequestBoundary(), {
      version: 1, requestId: 'sample-processed', runId: 'sample-run', model: 'sample::model',
      stopReason: 'end_turn', latencyMs: 1, usage: { inputTokens: 180_000 },
    });
    const teaching = 'Complete teaching. '.repeat(4_000) + 'Final sample instruction.';
    h.skills.getSkillDocs.mockResolvedValue(teaching);
    await h.apply([event('Pending selected task', ['sample-guide'])]);
    const prepared = await h.context.getMessagesForAI({
      systemPrompt: 'Sample system rules.', tools: [], model: { providerId: 'sample', modelId: 'model' },
    });
    expect(text(prepared.messages)).toContain(teaching);
    const entries = store.read('sample-main', h.runtime.id);
    expect(entries.some((entry) => entry.t === 'summary')).toBe(true);
    const restored = harness({ isResume: true });
    await restored.runtime.replayConversation(entries);
    await restored.runtime.start();
    await idle(restored.runtime);
    expect(text(restored.invoke.mock.calls[0][0].messages)).toContain(teaching);
    expect(restored.skills.getSkillDocs).not.toHaveBeenCalled();
    expect(userEntries(restored.runtime.id).filter((entry) => entry.metadata?.skills?.length)).toHaveLength(1);
  });

  it('restores pending tool results and selected input across repeated compaction and recovery', async () => {
    const h = harness();
    await h.runtime.prepare();
    const measured = {
      version: 1 as const, requestId: 'sample-processed', runId: 'sample-run', model: 'sample::model',
      stopReason: 'end_turn' as const, latencyMs: 1, usage: { inputTokens: 180_000 },
    };
    const request = {
      systemPrompt: 'Sample system rules.', tools: [], model: { providerId: 'sample', modelId: 'model' },
    };
    h.context.commitSuccessfulRequest(h.context.captureRequestBoundary(), measured);
    h.context.addUserMessage('Pending ordinary task');
    const ordinaryId = h.context.captureRequestBoundary()!;
    h.context.addAssistantMessage([{ type: 'tool_use', id: 'sample-read', name: 'read', input: {} }]);
    (h.runtime as unknown as { settler: import('../conversation/settler.js').Settler }).settler.settleLive({
      kind: 'system', callId: 'sample-read', toolName: 'read', text: 'Sample result', ok: true,
    });
    await h.apply([event('Selected task after result', ['sample-guide'])]);
    await h.context.getMessagesForAI(request);

    const restored = harness({ isResume: true });
    await restored.runtime.replayConversation(store.read('sample-main', h.runtime.id));
    await restored.runtime.prepare();
    restored.context.commitSuccessfulRequest(ordinaryId, measured);
    await restored.context.getMessagesForAI(request);
    const twiceRestored = harness({ isResume: true });
    await twiceRestored.runtime.replayConversation(store.read('sample-main', h.runtime.id));
    await twiceRestored.runtime.prepare();
    const messages = twiceRestored.runtime.buildContextSnapshot().messages;
    const blocks = messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
    expect(blocks.filter((block) => block.type === 'tool_use' && block.id === 'sample-read')).toHaveLength(1);
    expect(blocks.filter((block) => block.type === 'tool_result' && block.tool_use_id === 'sample-read')).toHaveLength(1);
    expect(text(messages)).toContain('Complete sample teaching for sample-guide.');
    expect(userEntries(h.runtime.id).filter((entry) => entry.metadata?.skills?.length)).toHaveLength(1);
  });

  it('includes selected teaching in provider token admission without truncating pending input', async () => {
    const countInputTokens = vi.fn<AgentInferencePort['countInputTokens']>(async () => 190_000);
    const h = harness({ inference: fakeAgentInference({ countInputTokens }) });
    await h.runtime.prepare();
    h.context.commitSuccessfulRequest(h.context.captureRequestBoundary(), {
      version: 1, requestId: 'sample-measured', runId: 'sample-run', model: 'sample::model',
      stopReason: 'end_turn', latencyMs: 1, usage: { inputTokens: 160_000 },
    });
    const teaching = 'Sample teaching. '.repeat(1_000).trim();
    h.skills.getSkillDocs.mockResolvedValue(teaching);
    await h.apply([event('', ['sample-guide'])]);
    const prepared = await h.context.getMessagesForAI({
      systemPrompt: 'Sample system rules.', tools: [], model: { providerId: 'sample', modelId: 'model' },
    });
    expect(countInputTokens).toHaveBeenCalled();
    expect(text(countInputTokens.mock.calls[0][0].messages)).toContain(teaching);
    expect(text(prepared.messages)).toContain(teaching);
  });

  it('projects and persists the actual Worker directory for control and read-only snapshots', async () => {
    const main = harness();
    const workspace = path.join(root, 'custom-worker-project');
    const child = harness({ role: 'worker', runtimeWorkspace: workspace });
    const modules = (main.runtime as unknown as { modules: unknown[] }).modules;
    modules.push({ name: 'sample-children', listChildAgents: () => [child.runtime] });
    expect(agentControlSnapshot(main.runtime.getControlState()).children[0].workspace).toBe(workspace);
    store.writeHeader('sample-main', main.runtime.buildHeader());
    expect(agentRunSnapshot(store.readHeader('sample-main')!).childAgents[0].workspace).toBe(workspace);
    const old = main.runtime.buildHeader();
    delete old.childAgents[0].workspace;
    store.writeHeader('sample-main', old);
    expect(store.readHeader('sample-main')?.childAgents[0].workspace).toBeUndefined();
  });
});
