const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Event', 'InputEvent', 'KeyboardEvent', 'MouseEvent', 'File', 'FileReader', 'Blob'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  return dom;
});
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationComposer } from '../ConversationComposer';
import { WelcomeInput } from '../WelcomeInput';
import { clearAllComposerDrafts, composerDraftKey, useComposerDraftStore, WELCOME_DRAFT_KEY } from '../../../data/composer-drafts';
import * as capture from '../../../attachments/capture';
import * as encoding from '../../../attachments/submission';
import { pngBytes, deferred } from '../../../attachments/__tests__/fixtures';

vi.mock('../../../../../components/agent-params/ApprovalModeSelector', () => ({ default: () => null }));
vi.mock('../../../../../components/agent-params/ModeSelector', () => ({ default: () => null }));
vi.mock('../../../../../components/BrowserEnvironmentBindingPicker', () => ({ default: () => null }));
vi.mock('../../../../../components/shared', () => ({ ModelReasoningControl: () => null }));
vi.mock('../ModelPicker', () => ({ ModelPicker: () => null }));
vi.mock('../ContextUsageRing', () => ({ ContextUsageRing: () => null }));
vi.mock('../useComposerSettings', () => ({ useComposerSettings: () => ({ modelGroups: [] }) }));
vi.mock('../../../data/useMcpPrewarm', () => ({ useMcpPrewarm: () => ({ claim: () => undefined, settle: vi.fn() }) }));
vi.mock('../../McpRuntimeCard', () => ({ McpRuntimeCard: () => null }));
vi.mock('../../../chrome/Popover', () => ({ Popover: ({ trigger }: { trigger: React.ReactNode }) => trigger }));
vi.mock('../../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));
let root: Root;
let container: HTMLDivElement;
let kind: 'main' | 'worker' | 'welcome';
const deliver = vi.fn();
const draftKey = () => kind === 'welcome' ? WELCOME_DRAFT_KEY : composerDraftKey('example-session', kind === 'worker' ? 'example-worker' : undefined);
const input = () => container.querySelector('textarea')!;
const snapshot = () => useComposerDraftStore.getState().drafts[draftKey()];

async function paste(plain = '', invalid = false) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  const file = new File([invalid ? new Uint8Array() : pngBytes()], 'example.png', { type: 'image/png' });
  Object.defineProperty(event, 'clipboardData', { value: {
    items: [{ kind: 'file', getAsFile: () => file }], types: ['Files'],
    getData: (type: string) => type === 'text/plain' ? plain : '',
  } });
  await act(async () => input().dispatchEvent(event));
  return event;
}
async function prepared() {
  const pending = snapshot()?.attachments.images.flatMap((image) => image.status === 'capturing' ? [image.capture.done] : []) ?? [];
  await act(async () => { await Promise.allSettled(pending); });
}
async function send(trigger = 'click') {
  await act(async () => {
    if (trigger === 'enter') input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    else container.querySelector<HTMLButtonElement>('[aria-label="发送"], [aria-label="Send"]')!.click();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2, height: 2, close: vi.fn() })));
  vi.spyOn(testDOM.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
  vi.spyOn(testDOM.window.HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob([pngBytes()], { type: 'image/png' })));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:example-thumbnail');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  Object.defineProperty(window, 'piskie', { configurable: true, value: {
    capabilities: { market: { availableSkills: vi.fn().mockResolvedValue([]), observeChanges: () => () => {} } },
    modes: { listAvailable: vi.fn().mockResolvedValue([]) },
  } });
  deliver.mockReset().mockResolvedValue(true);
  clearAllComposerDrafts();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); clearAllComposerDrafts(); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
afterAll(() => testDOM.window.close());

describe.each(['main', 'worker', 'welcome'] as const)('%s attachment submission', (variant) => {
  beforeEach(async () => {
    kind = variant;
    await act(async () => root.render(kind === 'welcome'
      ? React.createElement(WelcomeInput, { sending: false, onStart: async (text, options) => (await deliver({ text, ...options })) ? { kind: 'started', agentId: 'example-session' } : { kind: 'failed' } })
      : React.createElement(ConversationComposer, { agentId: 'example-session', workerId: kind === 'worker' ? 'example-worker' : undefined, targetName: 'Example', model: 'example-model', reasoningOverride: { kind: 'provider-default' }, approvalMode: 'confirm', sourceVersion: 0, canPause: false, onSubmit: deliver, onInterrupt: async () => undefined })));
  });

  it.each(['click', 'enter'])('submits mixed text and the original image with %s', async (trigger) => {
    await paste('Example mixed body'); await prepared();
    expect(input().value).toBe('Example mixed body');
    await send(trigger);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    expect(deliver.mock.calls[0]![0]).toMatchObject({ text: 'Example mixed body', images: [{ data: Buffer.from(pngBytes()).toString('base64'), media_type: 'image/png' }] });
    await vi.waitFor(() => expect(snapshot()).toBeUndefined());
  });

  it('shows capture errors, preserves ordinary text and recovers by re-pasting', async () => {
    await paste('Example body', true); await prepared(); await send();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(deliver).not.toHaveBeenCalled(); expect(input().value).toBe('Example body');
    await paste(); await prepared(); await send();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
  });

  it.each(['encode', 'delivery'])('shows %s errors and retries from the same stable Blob', async (failure) => {
    await paste('Example body'); await prepared();
    const stable = snapshot()!.attachments.images[0];
    if (failure === 'encode') vi.spyOn(encoding, 'blobToImagePayload').mockRejectedValueOnce(new Error('Example encoding failure'));
    else deliver.mockRejectedValueOnce(new Error('Example delivery failure'));
    await send();
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('Example'));
    expect(snapshot()!.attachments.images[0]).toBe(stable);
    await send(); await vi.waitFor(() => expect(snapshot()).toBeUndefined());
  });

  it('waits for the clicked batch, keeps input editable, and preserves newer text', async () => {
    const pending = deferred<Blob>(); vi.spyOn(capture, 'captureFile').mockReturnValueOnce(pending.promise);
    await paste('First body'); await send();
    expect(deliver).not.toHaveBeenCalled(); expect(input().disabled).toBe(false);
    await act(async () => useComposerDraftStore.getState().setDraft(draftKey(), 'Next body'));
    await act(async () => pending.resolve(new Blob([pngBytes()], { type: 'image/png' })));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    expect(deliver.mock.calls[0]![0].text).toBe('First body'); expect(input().value).toBe('Next body');
  });
});
