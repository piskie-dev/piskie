/**
 * 输入框里的待加入浏览器环境：仅选环境即可发送，随消息进入 payload；
 * 投递失败时草稿与选择都保留；标签可取消；非浏览器 Worker 不显示控件。
 */
const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Event', 'InputEvent', 'KeyboardEvent', 'MouseEvent'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  return dom;
});

import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserEnvironment } from '../../../../../../shared/types';
import { useBrowserEnvironmentStore } from '../../../../../store/browserEnvironmentStore';
import { ConversationComposer, type ConversationComposerProps } from '../ConversationComposer';
import { clearAllComposerDrafts, composerDraftKey, useComposerDraftStore } from '../../../data/composer-drafts';

vi.mock('../ModelPicker', () => ({ ModelPicker: () => null }));
vi.mock('../ContextUsageRing', () => ({ ContextUsageRing: () => null }));
vi.mock('../WorkspaceBar', () => ({ WorkspaceBar: () => null }));
vi.mock('../useComposerSettings', () => ({ useComposerSettings: () => ({ modelGroups: [] }) }));
vi.mock('../../../chrome/Popover', () => ({ Popover: ({ trigger }: { trigger: React.ReactNode }) => trigger }));
vi.mock('../../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));

const environments = [
  { id: 'environment-a', name: 'Sample shop', purpose: 'Sample purchasing', status: 'idle' },
  { id: 'environment-b', name: 'Sample forum', purpose: 'Sample posting', status: 'idle' },
] as BrowserEnvironment[];
const submit = vi.fn<ConversationComposerProps['onSubmit']>();
let root: Root;
let container: HTMLDivElement;
const draftKey = composerDraftKey('session-example');

async function render(browserResources: ConversationComposerProps['browserResources'], workerId?: string) {
  await act(async () => root.render(createElement(ConversationComposer, {
    agentId: 'session-example', workerId, workspace: '/workspace/example', targetName: 'Example target',
    model: 'example-provider::example-model', reasoningOverride: { kind: 'provider-default' },
    approvalMode: 'confirm', sourceVersion: 0, canPause: false, browserResources,
    onSubmit: submit, onInterrupt: vi.fn(),
  })));
}
const sendButton = () => container.querySelector<HTMLButtonElement>('[aria-label="发送"]')!;
const control = () => container.querySelector<HTMLElement>('[data-testid="session-browser-control"]');
const tags = () => [...container.querySelectorAll<HTMLElement>('[class*="tagName"]')].map((tag) => tag.textContent);
const select = async (ids: string[]) => act(async () => useComposerDraftStore.getState().setBrowserEnvironmentIds(draftKey, ids));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'piskie', { configurable: true, value: {
    runtime: { host: 'web' },
    capabilities: { market: { availableSkills: vi.fn().mockResolvedValue([]), observeChanges: () => () => undefined } },
    modes: { listAvailable: vi.fn().mockResolvedValue([]) },
    observability: { occupancy: { list: vi.fn().mockResolvedValue([]) } },
  } });
  useBrowserEnvironmentStore.setState({ environments, isLoading: false, error: null });
  submit.mockReset().mockResolvedValue(false);
  clearAllComposerDrafts();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearAllComposerDrafts();
  vi.unstubAllGlobals();
});
afterAll(async () => (await testDOM).window.close());

const sessionResources: ConversationComposerProps['browserResources'] = { kind: 'session', environmentIds: [], workers: [] };

describe('browser environments in the composer', () => {
  it('shows pending tags, enables sending with an empty body, and keeps everything after a failed delivery', async () => {
    await render(sessionResources);
    expect(control()!.textContent).toBe('选择浏览器…');
    expect(sendButton().disabled).toBe(true);

    await select(['environment-a', 'environment-b']);
    expect(tags()).toEqual(['Sample shop', 'Sample forum']);
    expect(control()!.dataset.pending).toBe('true');
    expect(sendButton().disabled).toBe(false);

    await act(async () => sendButton().click());
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      text: '', browserEnvironmentIds: ['environment-a', 'environment-b'], skills: undefined,
    }));
    expect(useComposerDraftStore.getState().drafts[draftKey]?.browserEnvironmentIds).toEqual(['environment-a', 'environment-b']);
    expect(tags()).toEqual(['Sample shop', 'Sample forum']);
  });

  it('clears the selection after a successful delivery and omits it when nothing is pending', async () => {
    submit.mockResolvedValue(true);
    await render(sessionResources);
    await select(['environment-a']);
    await act(async () => sendButton().click());
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ browserEnvironmentIds: ['environment-a'] }));
    expect(useComposerDraftStore.getState().drafts[draftKey]).toBeUndefined();
    expect(tags()).toEqual([]);

    await act(async () => useComposerDraftStore.getState().setDraft(draftKey, 'Plain message'));
    await act(async () => sendButton().click());
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Plain message', browserEnvironmentIds: undefined }));
  });

  it('removes a pending environment from its tag', async () => {
    await render(sessionResources);
    await select(['environment-a', 'environment-b']);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="取消加入 Sample shop"]')!.click());
    expect(tags()).toEqual(['Sample forum']);
    expect(useComposerDraftStore.getState().drafts[draftKey]?.browserEnvironmentIds).toEqual(['environment-b']);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="取消加入 Sample forum"]')!.click());
    expect(tags()).toEqual([]);
    expect(sendButton().disabled).toBe(true);
  });

  it('reflects the current session set in the trigger and shows browser Workers a read-only binding', async () => {
    await render({ kind: 'session', environmentIds: ['environment-a', 'environment-b'], workers: [] });
    expect(control()!.textContent).toBe('2 个浏览器');
    await render({ kind: 'worker', environmentId: 'environment-b' }, 'worker-example');
    expect(control()!.textContent).toBe('Sample forum');
    await render({ kind: 'worker' }, 'worker-example');
    expect(control()!.textContent).toBe('临时浏览器');
    await render(undefined, 'worker-example');
    expect(control()).toBeNull();
  });
});
