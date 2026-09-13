const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Event', 'KeyboardEvent', 'File', 'FileReader', 'Blob'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  return dom;
});

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { clearAllComposerDrafts, useComposerDraftStore } from '../../../data/composer-drafts';
import { pngBytes, deferred } from '../../../attachments/__tests__/fixtures';
import { PlanGate, type PlanGateProps } from '../PlanGate';
import type { GateDecision } from '../contract';

let root: Root;
let container: HTMLDivElement;
const onDecide = vi.fn<(decision: GateDecision) => Promise<boolean>>();
const input = () => container.querySelector('input')!;
const button = (key: string) => [...container.querySelectorAll('button')].find((item) =>
  item.textContent?.includes(i18n.t(`sessionWorkbenchUi.gate.${key}`)))!;
const send = () => container.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t('sessionWorkbenchUi.gate.send')}"]`)!;

function render(autoApproveAt?: number, disabled = false): void {
  const request: PlanGateProps['request'] = {
    kind: 'plan', taskSummary: 'Sample plan',
    call: {
      id: 'plan-a', agentId: 'agent-a', mainAgentId: 'agent-a', toolName: 'plan',
      params: { action: 'create' }, timestamp: new Date(), description: 'Review the plan',
      category: 'system', modeInvariant: true, autoApproveAt,
    },
  };
  act(() => root.render(React.createElement(PlanGate, { request, disabled, onDecide })));
}

function typeFeedback(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function paste(files: File[], text = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: {
    items: files.map((file) => ({ kind: 'file', getAsFile: () => file })), types: ['Files'],
    getData: (type: string) => type === 'text/plain' ? text : '',
  } });
  await act(async () => input().dispatchEvent(event));
}

async function prepareImages() {
  const captures = Object.values(useComposerDraftStore.getState().drafts).flatMap((draft) =>
    draft.attachments.images.flatMap((image) => image.status === 'capturing' ? [image.capture.done] : []));
  await act(async () => { await Promise.allSettled(captures); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2, height: 2, close: vi.fn() })));
  vi.spyOn(testDOM.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
  vi.spyOn(testDOM.window.HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob([pngBytes()], { type: 'image/png' })));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:sample-thumbnail');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  onDecide.mockReset().mockResolvedValue(true);
  clearAllComposerDrafts();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearAllComposerDrafts();
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage('zh-CN');
});
afterAll(() => testDOM.window.close());

describe('plan review countdown display', () => {
  it('keeps showing the same deadline after navigating away and back', () => {
    const deadline = Date.now() + 60_000;
    render(deadline);
    expect(container.querySelector('[role="timer"]')?.textContent).toContain('60');
    act(() => vi.advanceTimersByTime(20_000));
    expect(container.querySelector('[role="timer"]')?.textContent).toContain('40');
    act(() => root.render(null));
    act(() => vi.advanceTimersByTime(15_000));
    render(deadline);
    expect(container.querySelector('[role="timer"]')?.textContent).toContain('25');
  });

  it('hides the countdown when confirmation is required or the gate is disabled', () => {
    render();
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('等待手动确认');
    render(Date.now() + 60_000, true);
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(button('approvePlan').disabled).toBe(true);
    expect(button('rejectPlan').disabled).toBe(true);
    expect(input().disabled).toBe(true);
    act(() => button('rejectPlan').click());
    act(() => input().dispatchEvent(new Event('focusin', { bubbles: true })));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('allows immediate manual approval while the countdown is running', () => {
    render(Date.now() + 60_000);
    act(() => button('approvePlan').click());
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ kind: 'allow', callId: 'plan-a', changeToAuto: false });
  });

  it('rejects through its interrupt decision without sending feedback denial', () => {
    render(Date.now() + 60_000);
    act(() => button('rejectPlan').click());
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ kind: 'reject-plan', callId: 'plan-a' });
  });

  it('cancels beside the countdown, keeps feedback, and stays manual after remount', async () => {
    render(Date.now() + 46_000);
    const timer = container.querySelector('[role="timer"]')!;
    expect(timer.nextElementSibling).toBe(button('cancelPlanCountdown'));
    await act(async () => button('cancelPlanCountdown').click());
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ kind: 'cancel-plan-countdown', callId: 'plan-a' });
    // Only the backend snapshot removes the deadline.
    expect(container.querySelector('[role="timer"]')).not.toBeNull();
    render();
    typeFeedback('Revise the sample step');
    expect(input().value).toBe('Revise the sample step');
    expect(send().disabled).toBe(false);
    expect(button('approvePlan').disabled).toBe(false);
    expect(button('rejectPlan').disabled).toBe(false);
    act(() => root.render(null));
    act(() => vi.advanceTimersByTime(120_000));
    render();
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('等待手动确认');
    expect(onDecide).toHaveBeenCalledOnce();
  });

  it('cancels when editing starts and coalesces changes while cancellation is pending', async () => {
    const response = deferred<boolean>();
    onDecide.mockReturnValue(response.promise);
    render(Date.now() + 60_000);
    act(() => input().focus());
    typeFeedback('Sample feedback');
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ kind: 'cancel-plan-countdown', callId: 'plan-a' });
    expect(input().disabled).toBe(false);
    expect(button('cancelPlanCountdown').disabled).toBe(true);
    await act(async () => response.resolve(true));
    render();
    typeFeedback('Updated sample feedback');
    expect(onDecide).toHaveBeenCalledOnce();
  });

  it('cancels on a text change even without a focus event', async () => {
    render(Date.now() + 60_000);
    await act(async () => typeFeedback('Sample feedback'));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ kind: 'cancel-plan-countdown', callId: 'plan-a' });
  });

  it.each(['false', 'rejection'])('keeps the timer and reports a %s cancellation failure for retry', async (failure) => {
    if (failure === 'false') onDecide.mockResolvedValueOnce(false);
    else onDecide.mockRejectedValueOnce(new Error('Sample cancellation failure'));
    render(Date.now() + 60_000);
    await act(async () => button('cancelPlanCountdown').click());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[role="timer"]')).not.toBeNull();
    expect(button('cancelPlanCountdown').disabled).toBe(false);
    await act(async () => button('cancelPlanCountdown').click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onDecide).toHaveBeenCalledTimes(2);
  });

  it('shows the new actions and manual state in English', async () => {
    await i18n.changeLanguage('en-US');
    render(Date.now() + 46_000);
    expect(button('rejectPlan').textContent).toContain('Reject Plan');
    expect(button('cancelPlanCountdown').textContent).toBe('Cancel countdown');
    expect(container.querySelector('[role="timer"]')?.textContent).toContain('Auto-approve in 46s');
    render();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Waiting for manual approval');
  });
});

describe('plan modification feedback', () => {
  it('cancels on attachment-only paste and submits the file through feedback denial', async () => {
    render(Date.now() + 60_000);
    const file = new File(['Sample'], 'sample.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'path', { value: '/workspace/sample.md' });
    await paste([file]);
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ kind: 'cancel-plan-countdown', callId: 'plan-a' });
    render();
    expect(send().disabled).toBe(false);
    await act(async () => send().click());
    expect(onDecide).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'deny', callId: 'plan-a', feedback: expect.stringContaining('/workspace/sample.md') }));
    expect(container.textContent).not.toContain('sample.md');
  });

  it.each(['click', 'enter'])('preserves mixed text and images through %s feedback submission', async (trigger) => {
    render(Date.now() + 60_000);
    await paste([new File([pngBytes()], 'sample.png', { type: 'image/png' })], 'Sample modification');
    expect(onDecide.mock.calls[0]![0].kind).toBe('cancel-plan-countdown');
    await prepareImages();
    render();
    expect(input().value).toBe('Sample modification');
    await act(async () => {
      if (trigger === 'click') send().click();
      else input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(onDecide.mock.calls.at(-1)?.[0].kind).toBe('deny'));
    });
    expect(onDecide).toHaveBeenLastCalledWith({
      kind: 'deny', callId: 'plan-a', feedback: 'Sample modification',
      images: [{ data: Buffer.from(pngBytes()).toString('base64'), media_type: 'image/png' }],
    });
    expect(Object.values(useComposerDraftStore.getState().drafts).flatMap((draft) => draft.attachments.images)).toHaveLength(0);
  });

  it('keeps attachments and feedback after async failure, locks submission, and retries', async () => {
    render();
    await paste([new File([pngBytes()], 'sample.png', { type: 'image/png' })], 'Sample modification');
    await prepareImages();
    const response = deferred<boolean>();
    onDecide.mockReturnValueOnce(response.promise);
    await act(async () => {
      send().click();
      await vi.waitFor(() => expect(onDecide).toHaveBeenCalledOnce());
    });
    expect(send().disabled).toBe(true);
    expect(button('approvePlan').disabled).toBe(true);
    expect(button('rejectPlan').disabled).toBe(true);
    await act(async () => {
      button('approvePlan').click();
      button('rejectPlan').click();
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onDecide).toHaveBeenCalledOnce();
    await act(async () => response.reject(new Error('Sample delivery failure')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Sample delivery failure');
    expect(input().value).toBe('Sample modification');
    expect(send().disabled).toBe(false);
    const images = Object.values(useComposerDraftStore.getState().drafts).flatMap((draft) => draft.attachments.images);
    expect(images).toHaveLength(1);
    await act(async () => {
      send().click();
      await vi.waitFor(() => expect(onDecide).toHaveBeenCalledTimes(2));
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(Object.values(useComposerDraftStore.getState().drafts).flatMap((draft) => draft.attachments.images)).toHaveLength(0);
  });
});
