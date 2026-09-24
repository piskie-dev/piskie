/**
 * 会话中途加入浏览器环境：
 * 环境随用户消息进入同一条 UserMsgEntry（instructions + metadata），
 * Runtime 的当前集合 = 开场绑定 ∪ 已持久化的加入记录，投影到控制状态，重启从落盘条目恢复。
 */

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
vi.mock('../../services/browser-environment-runtime.js', () => ({
  browserEnvironmentRuntime: {
    getEnvironment: (id: string) => ({
      'environment-a': { id: 'environment-a', name: 'Sample shop', purpose: 'Sample purchasing' },
      'environment-b': { id: 'environment-b', name: 'Sample forum', purpose: 'Sample posting' },
    }[id]),
  },
}));

import { AgentRuntime } from '../agent-runtime.js';
import { AgentConversationContext } from '../context/agent-conversation-context.js';
import { ConversationStore } from '../../agent-runs/conversation-store.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { getStandaloneToolCatalog } from '../../tools/index.js';
import { JOINED_BROWSER_ENVIRONMENTS_MESSAGE } from '../context/session-browser-environments.js';
import type { AgentSpec } from '../specs/spec.js';
import type { SkillCatalogPort } from '../../core/pilot/pilot-manager.js';
import type { AgentInputEvent, Message } from '../../../shared/types/index.js';
import type { UserMsgEntry } from '../../../shared/types/agent-control.js';

let root: string;
let store: ConversationStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-browser-'));
  environment.profile = path.join(root, 'profile');
  environment.workspace = path.join(root, 'default-workspace');
  environment.temp = path.join(root, 'temp');
  await fs.mkdir(environment.profile);
  await fs.mkdir(environment.workspace);
  store = new ConversationStore(environment.profile);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function harness(options: { role?: 'director' | 'worker'; boundIds?: string[]; isResume?: boolean } = {}) {
  const role = options.role ?? 'director';
  const inference = fakeAgentInference();
  const invoke = vi.spyOn(inference, 'invoke');
  const spec: AgentSpec = {
    name: `${role}-sample`, role, modules: [],
    tools: { sdkGroups: [], customTools: [] },
    buildSystemPrompt: () => 'Sample system rules.',
  };
  const skills = {
    listManagedSkills: vi.fn(async () => []), classifySkill: vi.fn(async () => 'standard' as const),
    getSkillDocs: vi.fn(async () => ''), getSkillResourceRoot: vi.fn(() => undefined),
    getLoadedSkillModule: vi.fn(() => undefined), getToolCatalog: () => getStandaloneToolCatalog(),
    getDirectSkillToolNames: () => [],
  };
  const runtime = new AgentRuntime({
    id: role === 'director' ? 'sample-main' : 'sample-worker', spec, inference,
    pilotPorts: { skills: skills as unknown as SkillCatalogPort } as never,
    conversationStore: store,
    options: {
      mainAgentId: 'sample-main', initialModel: 'sample::model', isResume: options.isResume,
      runConfig: {
        name: 'Sample task', description: '', promptTemplate: 'Sample task',
        ...(options.boundIds ? { bindings: { type: 'standard', boundEnvironmentIds: options.boundIds } } : {}),
      },
      ...(role === 'worker' ? { subagentConfig: {
        type: 'local-worker', skills: [], subject: 'Sample assignment', prompt: 'Sample assignment',
      } } : {}),
    },
  });
  vi.spyOn(runtime as unknown as { prepareMcpSession(): Promise<void> }, 'prepareMcpSession')
    .mockResolvedValue(undefined);
  const context = (runtime as unknown as { context: AgentConversationContext }).context;
  return {
    runtime, invoke, context,
    apply: (events: AgentInputEvent[]) => (runtime as unknown as {
      applyEvents(events: AgentInputEvent[]): void | Promise<void>;
    }).applyEvents(events),
  };
}

function event(content: string, browserEnvironmentIds?: string[]): AgentInputEvent {
  return { id: `sample-event-${Math.random()}`, timestamp: new Date(), source: 'user', content, browserEnvironmentIds };
}
function text(messages: readonly Message[]): string { return JSON.stringify(messages); }
function userEntries(id: string): UserMsgEntry[] {
  return store.read('sample-main', id).filter((entry): entry is UserMsgEntry => entry.t === 'msg' && entry.role === 'user');
}

describe('session browser environments', () => {
  it('sends an environment-only message as one user entry carrying the description and ids', async () => {
    const h = harness();
    await h.runtime.prepare();
    await h.apply([event('', ['environment-a', 'environment-a'])]);
    const entries = userEntries(h.runtime.id);
    expect(entries).toHaveLength(2);
    const joined = entries.at(-1)!;
    expect(joined.content).toBe('');
    expect(joined.subtype).toBe('user_input');
    expect(joined.metadata).toEqual({ browserEnvironmentIds: ['environment-a'], userInput: { text: '' } });
    expect(joined.instructions).toContain(JOINED_BROWSER_ENVIRONMENTS_MESSAGE);
    expect(joined.instructions).toContain('- id: environment-a; name: Sample shop; purpose: Sample purchasing');
    expect(JSON.stringify(joined.content)).not.toContain(JOINED_BROWSER_ENVIRONMENTS_MESSAGE);
    expect(text(h.runtime.buildContextSnapshot().messages)).toContain('name: Sample shop');
    expect(h.runtime.getBrowserEnvironmentIds()).toEqual(['environment-a']);
  });

  it('combines the opening binding with joined ids in the control state without touching runConfig', async () => {
    const h = harness({ boundIds: ['environment-b'] });
    await h.runtime.prepare();
    expect(h.runtime.getControlState().browserEnvironmentIds).toEqual(['environment-b']);
    await h.apply([event('Please continue here', ['environment-a', 'environment-b'])]);
    expect(h.runtime.getControlState().browserEnvironmentIds).toEqual(['environment-b', 'environment-a']);
    expect(h.runtime.getControlState().runConfig.bindings).toEqual({ type: 'standard', boundEnvironmentIds: ['environment-b'] });
    expect(userEntries(h.runtime.id).at(-1)).toMatchObject({
      content: 'Please continue here', metadata: { browserEnvironmentIds: ['environment-a', 'environment-b'] },
    });
  });

  it('ignores environment selections for a worker and treats empty submissions as no-ops', async () => {
    const worker = harness({ role: 'worker' });
    await worker.runtime.prepare();
    await worker.apply([event('', ['environment-a'])]);
    expect(worker.runtime.getBrowserEnvironmentIds()).toEqual([]);
    expect(userEntries(worker.runtime.id).filter((entry) => entry.metadata?.browserEnvironmentIds)).toHaveLength(0);

    const main = harness();
    await main.runtime.prepare();
    const before = userEntries(main.runtime.id).length;
    await main.apply([event('', [])]);
    expect(userEntries(main.runtime.id)).toHaveLength(before);
  });

  it('keeps an environment selection separate from a pending ask_user answer', async () => {
    const h = harness();
    await h.runtime.prepare();
    h.context.addAssistantMessage([{ type: 'tool_use', id: 'sample-call', name: 'ask_user',
      input: { questions: [{ question: 'Choose a sample', options: [], multiSelect: false }] } }]);
    await h.apply([event('', ['environment-a'])]);
    const blocks = h.context.getAllMessages().flatMap((m) => Array.isArray(m.content) ? m.content : []);
    expect(blocks.filter((block) => block.type === 'tool_result')).toHaveLength(0);
    expect(h.runtime.getBrowserEnvironmentIds()).toEqual(['environment-a']);
  });

  it('restores the current set from every persisted user entry, including those before a summary', async () => {
    const h = harness({ boundIds: ['environment-b'] });
    await h.runtime.prepare();
    await h.apply([event('First join', ['environment-a'])]);
    const entries = store.read('sample-main', h.runtime.id);
    const summarized = [
      ...entries,
      { t: 'summary', id: 'sample-summary', ts: new Date().toISOString(), content: 'Sample summary', coversUpTo: entries.at(-1)!.id },
    ] as typeof entries;
    const restored = harness({ boundIds: ['environment-b'], isResume: true });
    await restored.runtime.replayConversation(summarized);
    expect(restored.runtime.getBrowserEnvironmentIds()).toEqual(['environment-b', 'environment-a']);
    expect(restored.runtime.getControlState().browserEnvironmentIds).toEqual(['environment-b', 'environment-a']);
  });
});
