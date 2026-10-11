import { JSDOM } from 'jsdom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Edge, Node, ReactFlowProps } from '@xyflow/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockMode, type DockModeProps } from '../../DockMode';
import type { DockPanelProps } from '../../DockPanel';
import { BrowserScreenView, type BrowserScreenViewProps } from '../../../../content/ScreenView';
import type { CanvasWorker } from '../useCanvasWorkers';

const vm = vi.hoisted(() => ({
  snapshot: { workers: [] as CanvasWorker[], phase: 'waiting' },
  listeners: new Set<() => void>(),
}));
const flow = vi.hoisted(() => ({
  fitView: vi.fn(async () => undefined),
  zoomIn: vi.fn(async () => undefined),
  zoomOut: vi.fn(async () => undefined),
}));
vi.mock('../../../../data/vm', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    vm.listeners.add(listener);
    return () => { vm.listeners.delete(listener); };
  };
  const useSnapshot = () => useSyncExternalStore(subscribe, () => vm.snapshot);
  return {
    useAgentVM: (agentId: string) => {
      const snapshot = useSnapshot();
      return {
        agentId, title: 'Example session', status: 'waiting', phase: snapshot.phase,
        workers: snapshot.workers.map((worker) => ({ ...worker, status: 'waiting', type: 'browser-worker' })),
      };
    },
    useWorkerVM: (_agentId: string, workerId?: string) => useSnapshot().workers.find((worker) => worker.id === workerId) ?? null,
  };
});
vi.mock('@/renderer-runtime/hooks', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    vm.listeners.add(listener);
    return () => { vm.listeners.delete(listener); };
  };
  return {
    useDisplayAgentState: () => ({ children: useSyncExternalStore(subscribe, () => vm.snapshot).workers }),
  };
});
vi.mock('../../../../data/useImageNodes', () => ({ useImageNodes: () => [] }));
vi.mock('../../../../content/ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('../../../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../DockPanel', () => ({
  DockPanel: ({ workerId, onOpenWorker }: DockPanelProps) => createElement('div', {
    'data-worker-panel': workerId ?? 'main',
  }, workerId && createElement('button', { onClick: () => onOpenWorker?.(workerId) }, `Open ${workerId}`)),
}));
vi.mock('../../../../content/ScreenView', () => ({
  BrowserScreenView: vi.fn(({ browserId, browserReady }: BrowserScreenViewProps) => createElement('div', {
    'data-screen': browserId, 'data-ready': String(browserReady),
  }, browserReady ? null : '等待浏览器启动…')),
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>();
  const { useState } = await import('react');
  const onChange = () => undefined;
  return {
    ...original,
    ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
    useReactFlow: () => flow,
    useNodesState: (initialNodes: Node[]) => {
      const [nodes, setNodes] = useState(initialNodes);
      return [nodes, setNodes, onChange];
    },
    useEdgesState: (initialEdges: Edge[]) => {
      const [edges, setEdges] = useState(initialEdges);
      return [edges, setEdges, onChange];
    },
    Handle: () => null,
    NodeResizer: () => null,
    ReactFlow: ({ nodes = [], edges = [], nodeTypes = {} }: ReactFlowProps) => createElement('div', { 'data-canvas': true },
      nodes.map((node) => createElement('div', {
        key: node.id, 'data-canvas-node': node.id, 'data-x': node.position.x, 'data-y': node.position.y,
      }, createElement(nodeTypes[node.type!]!, {
        id: node.id, data: node.data, type: node.type!, selected: false,
        draggable: node.draggable ?? true, dragging: false, selectable: true, deletable: false,
        zIndex: 0, isConnectable: false, positionAbsoluteX: node.position.x, positionAbsoluteY: node.position.y,
      }))),
      edges.map((edge) => createElement('div', {
        key: edge.id, 'data-edge': edge.id, 'data-source': edge.source, 'data-target': edge.target,
      })),
    ),
  };
});

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
beforeEach(() => {
  vi.clearAllMocks();
  vm.snapshot = {
    phase: 'waiting',
    workers: [
      { id: 'worker-one', subject: 'Worker one', phase: 'waiting', interrupted: false, browserId: 'automation-one', browserReady: false },
      { id: 'worker-two', subject: 'Worker two', phase: 'waiting', interrupted: false, browserId: 'automation-two', browserReady: true },
    ],
  };
  vm.listeners.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

async function render(overrides: Partial<DockModeProps> = {}) {
  const props: DockModeProps = {
    sessions: [], history: [], selectedAgentId: 'session-example',
    onSelectSession: vi.fn(), onSelectHistory: vi.fn(),
    menuSourceOf: () => ({ phase: 'waiting' }),
    sessionsCollapsed: true, onToggleSessions: vi.fn(), emptyState: null,
    ...overrides,
  };
  await act(async () => root.render(createElement(DockMode, props)));
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((element) => element.textContent === label);
  expect(button, `button: ${label}`).toBeDefined();
  await act(async () => button!.click());
}
async function updateBrowserReady(workerId: string, browserReady: boolean) {
  await act(async () => {
    vm.snapshot = {
      ...vm.snapshot,
      workers: vm.snapshot.workers.map((worker) => worker.id === workerId ? { ...worker, browserReady } : worker),
    };
    for (const listener of vm.listeners) listener();
  });
}
const node = (id: string) => container.querySelector<HTMLElement>(`[data-canvas-node="${id}"]`);
const edges = () => [...container.querySelectorAll<HTMLElement>('[data-edge]')].map((edge) => ({
  source: edge.dataset.source, target: edge.dataset.target,
}));
const focusedScreen = () => [...container.querySelectorAll<HTMLElement>('[data-screen]')].find((screen) => !screen.closest('[data-canvas]'));

describe('Dock screen readiness', () => {
  it('keeps unready Workers on the canvas without a screen, then adds the ready screen and its edge', async () => {
    await render();
    expect(node('worker-worker-one')).not.toBeNull();
    expect(node('screen-worker-one')).toBeNull();
    expect(node('screen-worker-two')).not.toBeNull();
    expect(edges()).toEqual([{ source: 'worker-worker-two', target: 'screen-worker-two' }]);
    expect(vi.mocked(BrowserScreenView).mock.calls.every(([props]) => props.browserReady)).toBe(true);
    expect(container.textContent).not.toContain('等待浏览器启动');
    const position = { x: node('worker-worker-one')!.dataset.x, y: node('worker-worker-one')!.dataset.y };

    await updateBrowserReady('worker-one', true);

    expect(node('screen-worker-one')?.querySelector<HTMLElement>('[data-screen]')?.dataset.ready).toBe('true');
    expect(edges()).toEqual([
      { source: 'worker-worker-one', target: 'screen-worker-one' },
      { source: 'worker-worker-two', target: 'screen-worker-two' },
    ]);
    expect({ x: node('worker-worker-one')!.dataset.x, y: node('worker-worker-one')!.dataset.y }).toEqual(position);

    await updateBrowserReady('worker-one', false);
    expect(node('screen-worker-one')).toBeNull();
    expect(edges()).toEqual([{ source: 'worker-worker-two', target: 'screen-worker-two' }]);
  });

  it('selects an unready Worker without the auxiliary screen and displays it on a live ready update', async () => {
    await render();
    await click('Worker one');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Worker one');
    expect(container.querySelector('[data-worker-panel="worker-one"]')).not.toBeNull();
    expect(node('worker-worker-one')).toBeNull();
    expect(focusedScreen()).toBeUndefined();
    expect(container.querySelector('[class*="subAux"]')).toBeNull();
    expect(container.textContent).not.toContain('等待浏览器启动');

    await updateBrowserReady('worker-one', true);
    expect(focusedScreen()?.dataset.screen).toBe('automation-one');
    expect(focusedScreen()?.dataset.ready).toBe('true');
    expect(node('screen-worker-one')).toBeNull();
    expect(container.querySelector('[class*="subAux"]')).not.toBeNull();

    await click('Worker one');
    expect(focusedScreen()).toBeUndefined();
    expect(node('screen-worker-one')).not.toBeNull();
    expect(edges()).toContainEqual({ source: 'worker-worker-one', target: 'screen-worker-one' });
  });

  it('moves focus between ready and unready Workers while maintaining their canvas screens and edges', async () => {
    await render();
    await click('Worker two');
    expect(focusedScreen()?.dataset.screen).toBe('automation-two');
    expect(node('worker-worker-one')).not.toBeNull();
    expect(edges()).toEqual([]);

    await click('Worker one');
    expect(focusedScreen()).toBeUndefined();
    expect(node('screen-worker-two')).not.toBeNull();
    expect(edges()).toEqual([{ source: 'worker-worker-two', target: 'screen-worker-two' }]);
    await updateBrowserReady('worker-one', true);
    expect(focusedScreen()?.dataset.screen).toBe('automation-one');
    await click('Worker two');
    expect(focusedScreen()?.dataset.screen).toBe('automation-two');
    expect(node('screen-worker-one')).not.toBeNull();
    expect(edges()).toEqual([{ source: 'worker-worker-one', target: 'screen-worker-one' }]);
  });

  it('keeps a reveal selection pending until that Worker is ready', async () => {
    await render({ revealWorker: { workerId: 'worker-one', requestId: 1 } });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Worker one');
    expect(focusedScreen()).toBeUndefined();
    await updateBrowserReady('worker-one', true);
    expect(focusedScreen()?.dataset.screen).toBe('automation-one');
  });

  it('continues pausing an existing canvas screen when the session stops', async () => {
    await render();
    expect(node('screen-worker-two')?.querySelector<HTMLElement>('[data-screen]')?.dataset.ready).toBe('true');
    await act(async () => {
      vm.snapshot = { ...vm.snapshot, phase: 'stopping' };
      for (const listener of vm.listeners) listener();
    });
    expect(node('screen-worker-two')?.querySelector<HTMLElement>('[data-screen]')?.dataset.ready).toBe('false');
    expect(edges()).toEqual([{ source: 'worker-worker-two', target: 'screen-worker-two' }]);
  });
});
