import { JSDOM } from 'jsdom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import type { TranscriptNode } from '@/domains/transcript/nodes';
import type { StatusKey } from '../../data/status';
import type { ConversationComposerProps } from '../../content/composer/ConversationComposer';
import { ThreadMode } from '../thread/ThreadMode';
import { DockMode } from '../dock/DockMode';

const state = vi.hoisted(() => ({
  workers: [{ id: 'worker-example', subject: 'Inspect the sample', type: 'explore', status: 'thinking' as StatusKey }],
  nodes: [] as TranscriptNode[],
}));
vi.mock('../../data/vm', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../data/vm')>(),
  useAgentVM: (agentId: string) => ({
    agentId, title: 'Example session', phase: 'waiting', status: 'waiting', workers: state.workers,
    pendingEvents: [], runMetrics: {}, workspace: '/workspace/example-main',
    reasoningOverride: { kind: 'effort', effort: 'high' },
  }),
  useWorkerVM: (_agentId: string, workerId?: string) => {
    const worker = state.workers.find((item) => item.id === workerId);
    return worker ? {
      ...worker, phase: 'thinking', taskIds: [], pendingEvents: [], runMetrics: {}, workspace: '/workspace/example-worker',
      reasoningOverride: { kind: 'effort', effort: 'low' },
    } : null;
  },
}));
vi.mock('../../data/useTranscript', () => ({
  useTranscript: (targetId: string) => ({ nodes: targetId === 'session-example' ? state.nodes : [], loaded: true }),
}));
vi.mock('../../data/actions', () => ({ useConsoleActions: () => ({}) }));
vi.mock('../../data/useMessageReadReceipt', () => ({ useMessageReadReceipt: () => ({}) }));
vi.mock('../../data/useImageNodes', () => ({ useImageNodes: () => [] }));
vi.mock('../../data/useKeyboard', () => ({ useGlobalBinding: () => undefined }));
vi.mock('../../content/useActionScope', () => ({ useActionScope: () => ({}) }));
vi.mock('../../content/ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../chrome/MenuButton', () => ({ MenuButton: () => null }));
vi.mock('../../content/ReviewSlot', () => ({ ReviewSlot: () => null }));
vi.mock('../../content/AgentMetricsStrip', () => ({ AgentMetricsStrip: () => null }));
vi.mock('../../content/AIRequestStatus', () => ({ AIRequestStatus: () => null }));
vi.mock('../../content/McpRuntimeCard', () => ({ McpRuntimeCard: () => null }));
vi.mock('../../content/Transcript', () => ({
  Transcript: ({ nodes, renderNode }: { nodes: TranscriptNode[]; renderNode: (node: TranscriptNode) => ReactNode }) => (
    createElement('div', null, nodes.map((node) => createElement('div', { key: node.id }, renderNode(node))))
  ),
}));
vi.mock('../../content/composer/ConversationComposer', () => ({
  ConversationComposer: ({ workerId, workspace, reasoningOverride }: ConversationComposerProps) => createElement('div', {
    'data-composer-target': workerId ?? 'main', 'data-workspace': workspace,
    'data-reasoning': JSON.stringify(reasoningOverride),
  }),
}));
vi.mock('../thread/RightPanel', () => ({ RightPanel: () => null }));
vi.mock('../thread/useEmbeddedBrowserState', () => ({ useEmbeddedBrowserState: () => ({ open: false }) }));
vi.mock('../dock/canvas/DockCanvas', () => ({ DockCanvas: () => null }));
vi.mock('../dock/canvas/useCanvasWorkers', () => ({ useCanvasWorkers: () => [] }));
vi.mock('@/utils/platform', () => ({ isMacOSPlatform: () => false }));
vi.mock('@/components/content-links', () => ({
  ContentLinkUrlScope: ({ children }: { children: ReactNode }) => children,
  LinkedMarkdown: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  LinkedText: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  dom.window.Element.prototype.getAnimations = () => [];
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
beforeEach(() => {
  state.workers = [{ id: 'worker-example', subject: 'Inspect the sample', type: 'explore', status: 'thinking' }];
  state.nodes = projectConversationNodes([{
    t: 'msg', ts: 1, id: 'message-example', role: 'assistant',
    content: [{ type: 'tool_use', id: 'call-example', name: 'subagent', input: {
      type: 'explore', subject: 'Inspect the sample', prompt: 'Inspect the sample result.',
    } }],
  }, {
    t: 'tool', ts: 2, toolUseId: 'call-example', ok: true,
    result: [{ type: 'text', text: 'Worker 已按要求创建: Inspect the sample\nsubagentId: worker-example' }],
  }]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

type Mode = 'thread' | 'dock';
async function render(mode: Mode) {
  const props = {
    sessions: [], history: [], selectedAgentId: 'session-example',
    onSelectSession: vi.fn(), onSelectHistory: vi.fn(),
    menuSourceOf: () => ({ phase: 'waiting' as const }),
    sessionsCollapsed: true, onToggleSessions: vi.fn(), emptyState: null,
  };
  await act(async () => root.render(mode === 'thread'
    ? createElement(ThreadMode, props)
    : createElement(DockMode, props)));
}
const row = () => container.querySelector<HTMLElement>('[class*="workerCreation"]');

describe.each(['thread', 'dock'] as const)('%s worker navigation', (mode) => {
  it('updates the row from Worker status and opens the matching tab and conversation', async () => {
    await render(mode);
    expect(row()?.dataset.live).toBe('true');
    expect(container.querySelector<HTMLElement>('[data-composer-target="main"]')?.dataset.workspace).toBe('/workspace/example-main');
    expect(container.querySelector<HTMLElement>('[data-composer-target="main"]')?.dataset.reasoning).toBe(JSON.stringify({ kind: 'effort', effort: 'high' }));
    state.workers = state.workers.map((worker) => ({ ...worker, status: 'waiting' }));
    await render(mode);
    expect(row()?.dataset.live).toBe('false');
    await act(async () => row()?.click());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Inspect the sample');
    expect(container.querySelector<HTMLElement>('[data-composer-target="worker-example"]')?.dataset.workspace).toBe('/workspace/example-worker');
    expect(container.querySelector<HTMLElement>('[data-composer-target="worker-example"]')?.dataset.reasoning).toBe(JSON.stringify({ kind: 'effort', effort: 'low' }));

    if (mode === 'dock') {
      await act(async () => row()?.click());
      expect(container.querySelector('[data-composer-target="worker-example"]')).not.toBeNull();
    }

    state.workers = [];
    await render(mode);
    expect(container.querySelector('[data-composer-target="worker-example"]')).toBeNull();
    expect(container.querySelector('[data-composer-target="main"]')).not.toBeNull();
    expect(row()?.dataset.live).toBe('false');
    expect((row() as HTMLButtonElement)?.disabled).toBe(true);
  });
});
