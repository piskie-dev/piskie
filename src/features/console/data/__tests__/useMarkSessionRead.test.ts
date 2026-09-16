import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunMessageState } from '@shared/agent-run-messages';
import type { AgentRunAttention } from '@/domains/agent-runs/agent-run-attention';

const h = vi.hoisted(() => ({
  markRead: vi.fn<(agentId: string, throughIndex: number) => Promise<AgentRunMessageState>>(),
  runs: [] as { agentId: string; messages: AgentRunMessageState }[],
  attentionByAgentId: {} as Record<string, AgentRunAttention>,
}));

vi.mock('@/renderer-runtime/hooks', () => ({
  useRendererRuntime: () => ({ agentRuns: { markRead: h.markRead } }),
  useAgentRunList: (selector: (state: Pick<typeof h, 'runs' | 'attentionByAgentId'>) => unknown) => selector(h),
}));

import { useMarkSessionRead } from '../useMarkSessionRead';

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://piskie.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  h.attentionByAgentId = {};
  h.markRead.mockReset();
  h.markRead.mockImplementation(async (_agentId, throughIndex) => ({
    latestMessage: { index: throughIndex, timestamp: 1 }, latestAssistantIndex: throughIndex, readThroughIndex: throughIndex,
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

function Probe({ agentId }: { agentId: string | undefined }) {
  useMarkSessionRead(agentId);
  return null;
}

const state = (latest: number, readThrough: number): AgentRunMessageState => ({
  latestMessage: { index: latest, timestamp: 1 }, latestAssistantIndex: latest, readThroughIndex: readThrough,
});

const render = async (agentId: string | undefined, messages: AgentRunMessageState) => {
  h.runs = [{ agentId: 'main', messages }];
  await act(async () => root.render(createElement(Probe, { agentId })));
};

describe('useMarkSessionRead', () => {
  it('marks the open session read through its latest message', async () => {
    await render('main', state(5, 1));
    expect(h.markRead.mock.calls).toEqual([['main', 5]]);
  });

  it('does nothing when the session is already read or not open', async () => {
    await render('main', state(5, 5));
    await render(undefined, state(7, 1));
    expect(h.markRead).not.toHaveBeenCalled();
  });

  it('reads a newly actionable entry in an open session even when the message cursor has not moved', async () => {
    await render('main', state(5, 5));
    h.attentionByAgentId = { main: { unread: true, unreadActionIds: ['sample-question'] } };
    await render('main', state(5, 5));
    expect(h.markRead.mock.calls).toEqual([['main', 5]]);
    h.attentionByAgentId = { main: { unread: false, unreadActionIds: [] } };
    await render('main', state(5, 5));
    h.attentionByAgentId = { main: { unread: true, unreadActionIds: ['sample-approval'] } };
    await render('main', state(5, 5));
    expect(h.markRead.mock.calls).toEqual([['main', 5], ['main', 5]]);
  });

  it('can read an action before the first message and leaves unopened worker tabs alone', async () => {
    h.runs = [];
    h.attentionByAgentId = { main: { unread: true, unreadActionIds: ['sample-image-review'] } };
    await act(async () => root.render(createElement(Probe, { agentId: undefined })));
    expect(h.markRead).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(Probe, { agentId: 'main' })));
    expect(h.markRead.mock.calls).toEqual([['main', -1]]);
  });

  it('keeps marking while the session stays open and new messages land', async () => {
    let finishRead: ((value: AgentRunMessageState) => void) | undefined;
    h.markRead.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    await render('main', state(5, 1));
    // A re-render while the first acknowledgement is still in flight must not send it twice.
    await render('main', state(5, 1));
    expect(h.markRead).toHaveBeenCalledTimes(1);
    finishRead?.(state(5, 5));
    await render('main', state(7, 5));
    expect(h.markRead.mock.calls).toEqual([['main', 5], ['main', 7]]);
  });
});
