const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Event', 'File'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  return dom;
});

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingToolCall } from '../../../../../shared/types';
import { clearAllComposerDrafts } from '../../data/composer-drafts';
import { ThreadView } from '../thread/ThreadView';
import { DockPanel } from '../dock/DockPanel';

const h = vi.hoisted(() => ({
  useAgentVM: vi.fn(), useWorkerVM: vi.fn(),
  agentCommands: {
    cancelPlanApprovalCountdown: vi.fn(), respondToApproval: vi.fn(),
    interrupt: vi.fn(), interruptSubagent: vi.fn(), stop: vi.fn(),
  },
}));
vi.mock('../../../../renderer-runtime/hooks', () => ({ useRendererRuntime: () => ({ agentCommands: h.agentCommands }) }));
vi.mock('../../data/vm', async (importOriginal) => ({
  ...await importOriginal<object>(), useAgentVM: h.useAgentVM, useWorkerVM: h.useWorkerVM,
}));
vi.mock('@/components/content-links', () => ({
  ContentLinkUrlScope: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../data/useTranscript', () => ({ useTranscript: () => ({ nodes: [], loaded: true }) }));
vi.mock('../../data/useMarkSessionRead', () => ({ useMarkSessionRead: () => undefined }));
vi.mock('../../content/useActionScope', () => ({ useActionScope: () => ({}) }));
vi.mock('../../content/Transcript', () => ({ Transcript: () => null }));
vi.mock('../../content/ThreadCell', () => ({ ThreadCell: () => null }));
vi.mock('../../content/ImageReview', () => ({ ImageReview: () => null }));
vi.mock('../../content/TaskList', () => ({ TaskList: () => null }));
vi.mock('../../content/McpRuntimeCard', () => ({ McpRuntimeCard: () => null }));
vi.mock('../../content/AIRequestStatus', () => ({ AIRequestStatus: () => null }));
vi.mock('../../content/AgentMetricsStrip', () => ({ AgentMetricsStrip: () => null }));
vi.mock('../../content/FileChangeSummary', () => ({ FileChangeSummary: () => null }));
vi.mock('../../content/ReviewSlot', () => ({ ReviewSlot: () => null }));
vi.mock('../../content/composer/PendingEventQueue', () => ({ PendingEventQueue: () => null }));
vi.mock('../../chrome/Dialog', () => ({ Dialog: () => null }));
vi.mock('../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../content/composer/ConversationComposer', () => ({
  ConversationComposer: ({ agentId, workerId }: { agentId: string; workerId?: string }) =>
    React.createElement('textarea', { 'aria-label': 'Sample composer', 'data-target': workerId ?? agentId }),
}));

interface TargetView {
  readonly phase: string;
  readonly title: string;
  readonly subject: string;
  readonly type: string;
  readonly taskIds: string[];
  readonly workers: never[];
  readonly pendingToolCall?: PendingToolCall;
}
const useViews = create<{ main: TargetView; worker: TargetView }>(() => ({} as never));
let root: Root;
let container: HTMLDivElement;
const mainId = 'sample-main';
const workerId = 'sample-worker';
const plan = (agentId: string): PendingToolCall => ({
  id: `${agentId}-plan`, agentId, mainAgentId: mainId, toolName: 'plan', category: 'system',
  description: 'Sample plan', params: { action: 'create', taskSummary: 'Sample plan' },
  timestamp: new Date(), modeInvariant: true, autoApproveAt: Date.now() + 60_000,
});
const view = (agentId: string): TargetView => ({
  phase: 'executing', title: 'Sample task', subject: 'Sample task', type: 'local-worker',
  taskIds: [], workers: [], pendingToolCall: plan(agentId),
});
const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text))!;
const render = (layout: 'thread' | 'dock', subagentId?: string) => root.render(React.createElement(layout === 'thread' ? ThreadView : DockPanel, { agentId: mainId, workerId: subagentId }));
const setPending = (subagentId: string | undefined, pendingToolCall?: PendingToolCall) => {
  const key = subagentId ? 'worker' : 'main';
  useViews.setState((state) => ({ [key]: { ...state[key], pendingToolCall } }));
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  clearAllComposerDrafts();
  useViews.setState({ main: view(mainId), worker: view(workerId) });
  h.useAgentVM.mockImplementation(() => useViews((state) => state.main));
  h.useWorkerVM.mockImplementation((_agentId, id) => {
    const worker = useViews((state) => state.worker);
    return id ? worker : null;
  });
  for (const command of Object.values(h.agentCommands)) command.mockReset().mockResolvedValue({ ok: true });
  h.agentCommands.cancelPlanApprovalCountdown.mockImplementation(async (_agentId, subagentId) => {
    const call = useViews.getState()[subagentId ? 'worker' : 'main'].pendingToolCall!;
    setPending(subagentId, { ...call, autoApproveAt: undefined });
    return { ok: true };
  });
  h.agentCommands.interrupt.mockImplementation(async () => { setPending(undefined); return { ok: true }; });
  h.agentCommands.interruptSubagent.mockImplementation(async (_agentId, subagentId) => { setPending(subagentId); return { ok: true }; });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); clearAllComposerDrafts(); container.remove(); vi.unstubAllGlobals();
});
afterAll(() => testDOM.window.close());

describe.each(['thread', 'dock'] as const)('%s plan actions', (layout) => {
  describe.each([undefined, workerId])('target %s', (subagentId) => {
    beforeEach(async () => { await act(async () => render(layout, subagentId)); });

    it('cancels the targeted plan and remains manual when switching layouts', async () => {
      await act(async () => button('取消倒计时').click());
      expect(h.agentCommands.cancelPlanApprovalCountdown).toHaveBeenCalledExactlyOnceWith(mainId, subagentId, `${subagentId ?? mainId}-plan`);
      expect(container.querySelector('[role="timer"]')).toBeNull();
      expect(container.textContent).toContain('等待手动确认');
      expect(container.querySelector('textarea')).toBeNull();
      const other = useViews.getState()[subagentId ? 'main' : 'worker'];
      expect(other.pendingToolCall?.autoApproveAt).toBeDefined();
      await act(async () => root.render(null));
      await act(async () => render(layout === 'thread' ? 'dock' : 'thread', subagentId));
      expect(container.querySelector('[role="timer"]')).toBeNull();
      expect(container.textContent).toContain('等待手动确认');
      expect(h.agentCommands.respondToApproval).not.toHaveBeenCalled();
    });

    it('rejects with recoverable interruption, clears the gate and restores the targeted composer', async () => {
      await act(async () => button('拒绝计划').click());
      if (subagentId) {
        expect(h.agentCommands.interruptSubagent).toHaveBeenCalledExactlyOnceWith(mainId, subagentId);
        expect(h.agentCommands.interrupt).not.toHaveBeenCalled();
      } else {
        expect(h.agentCommands.interrupt).toHaveBeenCalledExactlyOnceWith(mainId);
        expect(h.agentCommands.interruptSubagent).not.toHaveBeenCalled();
      }
      expect(h.agentCommands.respondToApproval).not.toHaveBeenCalled();
      expect(h.agentCommands.stop).not.toHaveBeenCalled();
      expect(container.querySelector('[role="timer"]')).toBeNull();
      expect(container.querySelector('input')).toBeNull();
      expect(container.querySelector('textarea')?.dataset.target).toBe(subagentId ?? mainId);
    });

    it('reports cancellation failure and preserves attachment feedback after a failed deny', async () => {
      h.agentCommands.cancelPlanApprovalCountdown.mockResolvedValueOnce({ ok: false, error: 'Sample cancellation failure' });
      await act(async () => button('取消倒计时').click());
      expect(container.textContent).toContain('Sample cancellation failure');
      expect(container.querySelector('[role="timer"]')).not.toBeNull();
      await act(async () => button('取消倒计时').click());
      const file = new File(['Sample'], 'sample.md', { type: 'text/markdown' });
      Object.defineProperty(file, 'path', { value: '/workspace/sample.md' });
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: {
        items: [{ kind: 'file', getAsFile: () => file }], types: ['Files'],
        getData: (type: string) => type === 'text/plain' ? 'Sample modification' : '',
      } });
      await act(async () => container.querySelector('input')!.dispatchEvent(event));
      h.agentCommands.respondToApproval.mockResolvedValueOnce({ ok: false, error: 'Sample feedback failure' });
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
      expect(h.agentCommands.respondToApproval).toHaveBeenCalledExactlyOnceWith(mainId, subagentId, expect.objectContaining({
        callId: `${subagentId ?? mainId}-plan`, decision: 'deny', feedback: expect.stringContaining('Sample modification'),
      }));
      expect(h.agentCommands.respondToApproval.mock.calls[0]![2].feedback).toContain('/workspace/sample.md');
      expect(container.textContent).toContain('Sample feedback failure');
      expect(container.textContent).toContain('sample.md');
      expect(container.querySelector('input')?.value).toBe('Sample modification');
      expect(h.agentCommands.interrupt).not.toHaveBeenCalled();
      expect(h.agentCommands.interruptSubagent).not.toHaveBeenCalled();
    });
  });
});
