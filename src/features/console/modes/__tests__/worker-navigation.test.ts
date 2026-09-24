import { JSDOM } from 'jsdom';
import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import type { ToolNode, TranscriptNode } from '@/domains/transcript/nodes';
import { createTranscriptStore, type TranscriptStore } from '@/domains/transcript/transcript-store';
import { RendererRuntimeProvider } from '@/renderer-runtime/RendererRuntimeProvider';
import type { RendererRuntime } from '@/renderer-runtime/renderer-runtime';
import { mountShortcutListener, resetShortcutRegistry } from '@/shortcuts';
import type { StatusKey } from '../../data/status';
import type { ConversationComposerProps } from '../../content/composer/ConversationComposer';
import { ThreadMode } from '../thread/ThreadMode';
import { DockMode } from '../dock/DockMode';

const state = vi.hoisted(() => ({
  workers: [{ id: 'worker-example', subject: 'Inspect the sample', type: 'explore', status: 'thinking' as StatusKey }],
  nodes: [] as TranscriptNode[],
  transcriptEverywhere: false,
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
      ...worker, phase: 'thinking', pendingEvents: [], runMetrics: {}, workspace: '/workspace/example-worker',
      reasoningOverride: { kind: 'effort', effort: 'low' },
    } : null;
  },
}));
vi.mock('../../data/useTranscript', () => ({
  useTranscript: (targetId: string) => ({
    nodes: targetId === 'session-example' || state.transcriptEverywhere ? state.nodes : [],
    loaded: true,
  }),
}));
vi.mock('../../data/actions', () => ({ useConsoleActions: () => ({}) }));
vi.mock('../../data/useMarkSessionRead', () => ({ useMarkSessionRead: () => undefined }));
vi.mock('../../data/useImageNodes', () => ({ useImageNodes: () => [] }));
vi.mock('../../data/useKeyboard', () => ({ useGlobalBinding: () => undefined }));
vi.mock('../../content/useActionScope', () => ({
  useActionScope: ({ onActivateOwner }: { onActivateOwner?: () => void }) => ({
    onPointerDownCapture: onActivateOwner,
    onFocusCapture: onActivateOwner,
  }),
}));
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
  ConversationComposer: ({ workerId, workspace, reasoningOverride, isShortcutOwner, deferEscapeFallback }: ConversationComposerProps) => createElement('div', {
    'data-composer-target': workerId ?? 'main', 'data-workspace': workspace,
    'data-reasoning': JSON.stringify(reasoningOverride),
    'data-shortcut-owner': isShortcutOwner ? 'true' : undefined,
    'data-defer-escape': deferEscapeFallback ? 'true' : undefined,
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
let transcript: TranscriptStore;
let runtime: RendererRuntime;
let disposeListener: () => void;
const RuntimeProvider = RendererRuntimeProvider as ComponentType<{ readonly runtime: RendererRuntime }>;
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  dom.window.Element.prototype.getAnimations = () => [];
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
});
beforeEach(() => {
  resetShortcutRegistry();
  state.workers = [{ id: 'worker-example', subject: 'Inspect the sample', type: 'explore', status: 'thinking' }];
  state.transcriptEverywhere = false;
  state.nodes = projectConversationNodes([{
    t: 'msg', ts: 1, id: 'message-example', role: 'assistant',
    content: [{ type: 'tool_use', id: 'call-example', name: 'subagent', input: {
      type: 'explore', subject: 'Inspect the sample', prompt: 'Inspect the sample result.',
    } }],
  }, {
    t: 'tool', ts: 2, toolUseId: 'call-example', ok: true,
    result: [{ type: 'text', text: 'Worker 已按要求创建: Inspect the sample\nsubagentId: worker-example' }],
  }]);
  transcript = createTranscriptStore({
    conversation: vi.fn(async () => ({ from: 0, entries: [], total: 0 })),
  });
  runtime = { transcript } as unknown as RendererRuntime;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  disposeListener = mountShortcutListener(dom.window as unknown as Window);
});
afterEach(async () => {
  await act(async () => root.unmount());
  disposeListener();
  resetShortcutRegistry();
  transcript.close();
  container.remove();
});
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

type Mode = 'thread' | 'dock';
async function render(mode: Mode) {
  const props = {
    sessions: [], history: [], selectedAgentId: 'session-example',
    onSelectSession: vi.fn(), onSelectHistory: vi.fn(),
    menuSourceOf: () => ({ phase: 'waiting' as const }),
    sessionsCollapsed: true, onToggleSessions: vi.fn(), emptyState: null,
  };
  const content = mode === 'thread'
    ? createElement(ThreadMode, props)
    : createElement(DockMode, props);
  await act(async () => root.render(createElement(RuntimeProvider, { runtime }, content)));
}
const row = () => container.querySelector<HTMLElement>('[class*="workerCreation"]');
async function pressEscape() {
  const event = new dom.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  });
  await act(async () => dom.window.dispatchEvent(event));
  return event;
}

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

  it('returns from a Worker only after higher-priority scopes decline Escape', async () => {
    await render(mode);
    await act(async () => row()?.click());
    expect(container.querySelector('[data-composer-target="worker-example"]')).not.toBeNull();

    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(container.querySelector('[data-composer-target="worker-example"]')).toBeNull();
    expect(container.querySelector('[data-composer-target="main"]')).not.toBeNull();
  });
});

describe('Dock active primary owner', () => {
  it('moves from the selected Worker back to the main panel after main-panel interaction', async () => {
    await render('dock');
    expect(container.querySelector('[data-composer-target="main"]')?.getAttribute('data-shortcut-owner'))
      .toBe('true');

    await act(async () => row()?.click());
    const main = container.querySelector<HTMLElement>('[data-composer-target="main"]')!;
    const worker = container.querySelector<HTMLElement>('[data-composer-target="worker-example"]')!;
    expect(main.hasAttribute('data-shortcut-owner')).toBe(false);
    expect(worker.getAttribute('data-shortcut-owner')).toBe('true');
    expect(main.closest('section')?.hasAttribute('data-shortcut-owner')).toBe(false);
    expect(worker.closest('section')?.getAttribute('data-shortcut-owner')).toBe('true');

    await act(async () => main.closest('section')?.dispatchEvent(new dom.window.MouseEvent('pointerdown', {
      bubbles: true,
    })));
    expect(main.getAttribute('data-shortcut-owner')).toBe('true');
    expect(worker.hasAttribute('data-shortcut-owner')).toBe(false);
    expect(main.closest('section')?.getAttribute('data-shortcut-owner')).toBe('true');
  });
});

describe('Thread transient Review', () => {
  it('closes Review before applying Worker navigation', async () => {
    const fileNode: ToolNode = {
      kind: 'tool',
      id: 'file-example',
      ts: 3,
      sourceIndex: 2,
      tool: 'read',
      titleKey: 'transcript.tool.read',
      tone: 'neutral',
      interaction: 'none',
      defaultExpanded: false,
      summaryDuplicatesDetail: false,
      actions: [],
      state: { phase: 'ok' },
      fileOp: {
        kind: 'read',
        path: '/workspace/example.ts',
        content: 'export const sample = true;',
        startLine: 1,
        endLine: 1,
      },
    };
    state.nodes = [...state.nodes, fileNode];
    state.transcriptEverywhere = true;
    await render('thread');
    await act(async () => row()?.click());
    const reviewAction = [...container.querySelectorAll<HTMLButtonElement>('[data-clickable="true"]')]
      .find((button) => button.textContent?.includes('/workspace/example.ts'))!;
    await act(async () => reviewAction.click());
    expect(container.querySelector('[data-composer-target="worker-example"]')?.getAttribute('data-defer-escape'))
      .toBe('true');

    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(container.querySelector('[data-composer-target="worker-example"]')).not.toBeNull();
    expect(container.querySelector('[data-composer-target="worker-example"]')?.hasAttribute('data-defer-escape'))
      .toBe(false);

    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(container.querySelector('[data-composer-target="worker-example"]')).toBeNull();
    expect(container.querySelector('[data-composer-target="main"]')).not.toBeNull();
  });
});
