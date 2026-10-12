import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CDPSession, Page } from 'puppeteer-core';
import { ScreenCaster, type ScreencastFrame } from '../screen-caster.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const screenshot = deferred<{ data: string }>();
  const ack = deferred<void>();
  const session = Object.assign(new EventEmitter(), {
    send: vi.fn((method: string) => {
      if (method === 'Page.captureScreenshot') return screenshot.promise;
      if (method === 'Page.screencastFrameAck') return ack.promise;
      if (method === 'Page.getLayoutMetrics') return Promise.resolve({
        visualViewport: { clientWidth: 640, clientHeight: 480, scale: 1.25 },
        cssVisualViewport: { pageX: 0, pageY: 120 },
      });
      return Promise.resolve();
    }),
    detach: vi.fn(async () => {}),
  });
  const page = { createCDPSession: vi.fn(async () => session as unknown as CDPSession),
    url: () => 'https://example.test/sample', isClosed: () => false, viewport: () => null } as unknown as Page;
  return { page, session, screenshot, ack };
}
const identity = (pageId = 1, navigationSequence = 0) => ({ pageId, navigationSequence, connectionId: 'sample-connection' });
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }
afterEach(() => vi.useRealTimers());

describe('ScreenCaster capture ownership', () => {
  it('discards an ACK and screenshot that finish across page rebind, then emits only the new owner', async () => {
    const first = fixture();
    const next = fixture();
    const caster = new ScreenCaster(first.page, {}, identity());
    const frames: ScreencastFrame[] = [];
    caster.on('frame', (frame) => frames.push(frame));
    await caster.start();
    first.session.emit('Page.screencastFrame', { data: 'sample-old', sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600 } });
    const rebind = caster.rebind(next.page, identity(2));
    first.ack.resolve();
    first.screenshot.resolve({ data: 'sample-old-screenshot' });
    await rebind;
    await flush();
    expect(frames).toEqual([]);
    expect(first.session.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 1 });
    expect(first.session.detach).toHaveBeenCalledOnce();
    next.session.emit('Page.screencastFrame', { data: 'sample-new', sessionId: 2,
      metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1.25, offsetTop: 4 } });
    next.ack.resolve();
    await flush();
    expect(frames).toEqual([expect.objectContaining({ page: identity(2), mapping: { scale: 1.25, offsetX: 0, offsetY: 4 } })]);
    await caster.stop();
  });

  it('coalesces requested current screenshots, fences late pixels by capture owner and stops requesting after disposal', async () => {
    const first = fixture(), next = fixture();
    const caster = new ScreenCaster(first.page, {}, identity());
    const frames: ScreencastFrame[] = [];
    caster.on('frame', (frame) => frames.push(frame));
    await caster.start();
    first.screenshot.resolve({ data: 'sample-initial' });
    await flush();
    const held = deferred<{ data: string }>();
    const originalSend = first.session.send.getMockImplementation()!;
    first.session.send.mockImplementation((method) => method === 'Page.captureScreenshot' ? held.promise : originalSend(method));
    const refresh = caster.refreshFrame();
    expect(caster.refreshFrame()).toBe(refresh);
    expect(first.session.send.mock.calls.filter(([method]) => method === 'Page.captureScreenshot')).toHaveLength(2);
    const rebinding = caster.rebind(next.page, identity(2));
    await caster.refreshFrame();
    expect(first.session.send.mock.calls.filter(([method]) => method === 'Page.captureScreenshot')).toHaveLength(2);
    await rebinding;
    held.resolve({ data: 'sample-obsolete-refresh' });
    await refresh;
    next.screenshot.resolve({ data: 'sample-current' });
    await flush();
    expect(frames.map((frame) => frame.data)).toEqual(['sample-initial', 'sample-current']);
    expect(frames.at(-1)?.page).toEqual(identity(2));
    expect(first.session.send.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
    await caster.stop();
    const calls = next.session.send.mock.calls.length;
    await caster.refreshFrame();
    expect(next.session.send).toHaveBeenCalledTimes(calls);
  });

  it('restarts the capture identity on navigation of the same Page and measures first screenshot without page.viewport', async () => {
    const first = fixture();
    const next = fixture();
    vi.mocked(first.page.createCDPSession).mockResolvedValueOnce(first.session as unknown as CDPSession)
      .mockResolvedValueOnce(next.session as unknown as CDPSession);
    const caster = new ScreenCaster(first.page, {}, identity());
    const frames: ScreencastFrame[] = [];
    caster.on('frame', (frame) => frames.push(frame));
    await caster.start();
    const navigating = caster.rebind(first.page, identity(1, 1));
    first.screenshot.resolve({ data: 'sample-old' });
    await navigating;
    next.screenshot.resolve({ data: 'sample-new' });
    await flush();
    expect(frames).toEqual([expect.objectContaining({ page: identity(1, 1), deviceWidth: 800, deviceHeight: 600,
      scrollOffsetY: 120, mapping: { scale: 1.25, offsetX: 0, offsetY: 0 } })]);
    await caster.stop();
  });

  it('keeps the latest target through an immediate A to B to A switch', async () => {
    const first = fixture();
    const second = fixture();
    const returned = fixture();
    vi.mocked(first.page.createCDPSession).mockResolvedValueOnce(first.session as unknown as CDPSession)
      .mockResolvedValueOnce(returned.session as unknown as CDPSession);
    const caster = new ScreenCaster(first.page, {}, identity());
    const frames: ScreencastFrame[] = [];
    caster.on('frame', (frame) => frames.push(frame));
    await caster.start();
    await Promise.all([caster.rebind(second.page, identity(2)), caster.rebind(first.page, identity())]);
    returned.session.emit('Page.screencastFrame', { data: 'sample-returned', sessionId: 3, metadata: { deviceWidth: 800, deviceHeight: 600 } });
    returned.ack.resolve();
    await flush();
    expect(frames).toEqual([expect.objectContaining({ page: identity(), data: 'sample-returned' })]);
    await caster.stop();
  });

  it('keeps the latest target when it changes during CDP cleanup and stop cancels queued rebind work', async () => {
    const first = fixture();
    const second = fixture();
    const returned = fixture();
    const detaching = deferred<void>();
    first.session.detach.mockReturnValueOnce(detaching.promise);
    vi.mocked(first.page.createCDPSession).mockResolvedValueOnce(first.session as unknown as CDPSession)
      .mockResolvedValueOnce(returned.session as unknown as CDPSession);
    const caster = new ScreenCaster(first.page, {}, identity());
    const frames: ScreencastFrame[] = [];
    caster.on('frame', (frame) => frames.push(frame));
    await caster.start();
    const toSecond = caster.rebind(second.page, identity(2));
    await flush();
    const back = caster.rebind(first.page, identity());
    detaching.resolve();
    await Promise.all([toSecond, back]);
    returned.session.emit('Page.screencastFrame', { data: 'sample-returned', sessionId: 4, metadata: {} });
    returned.ack.resolve();
    await flush();
    expect(frames.at(-1)).toMatchObject({ page: identity(), data: 'sample-returned' });
    const queued = caster.rebind(second.page, identity(2));
    await caster.stop();
    await queued;
    expect(second.page.createCDPSession).not.toHaveBeenCalled();
  });

  it('does not tear down the replacement capture when old CDP session creation rejects late', async () => {
    const first = fixture();
    const next = fixture();
    const creating = deferred<CDPSession>();
    vi.mocked(first.page.createCDPSession).mockReturnValue(creating.promise);
    const caster = new ScreenCaster(first.page, {}, identity());
    const frames: ScreencastFrame[] = [];
    caster.on('frame', (frame) => frames.push(frame));
    const oldStart = caster.start();
    await caster.rebind(next.page, identity(2));
    creating.reject(new Error('Sample closed target'));
    await expect(oldStart).resolves.toBeUndefined();
    next.session.emit('Page.screencastFrame', { data: 'sample-current', sessionId: 5, metadata: {} });
    next.ack.resolve();
    await flush();
    expect(frames).toEqual([expect.objectContaining({ page: identity(2), data: 'sample-current' })]);
    await caster.stop();
  });

  it('invalidates pending capture creation at stop and detaches the eventual session', async () => {
    const test = fixture();
    const creating = deferred<CDPSession>();
    vi.mocked(test.page.createCDPSession).mockReturnValue(creating.promise);
    const caster = new ScreenCaster(test.page, {}, identity());
    const started = caster.start();
    await caster.stop();
    creating.resolve(test.session as unknown as CDPSession);
    await started;
    expect(test.session.detach).toHaveBeenCalledOnce();
    expect(test.session.send).not.toHaveBeenCalled();
  });

  it.each([
    ['during-cleanup', 'resolve'], ['during-cleanup', 'reject'],
    ['after-replacement', 'resolve'], ['after-replacement', 'reject'],
  ] as const)('keeps navigation replacement alive when the old options stop finishes %s/%s', async (phase, outcome) => {
    vi.useFakeTimers();
    const first = fixture();
    const next = fixture();
    const stopped = deferred<void>();
    const detached = deferred<void>();
    const send = first.session.send.getMockImplementation()!;
    let stopCount = 0;
    first.session.send.mockImplementation((method) => {
      if (method === 'Page.stopScreencast' && stopCount++ === 0) return stopped.promise;
      return send(method);
    });
    if (phase === 'during-cleanup') first.session.detach.mockReturnValueOnce(detached.promise);
    vi.mocked(first.page.createCDPSession).mockResolvedValueOnce(first.session as unknown as CDPSession)
      .mockResolvedValueOnce(next.session as unknown as CDPSession);
    const caster = new ScreenCaster(first.page, {}, identity());
    const errors: Error[] = [];
    const frames: ScreencastFrame[] = [];
    caster.on('error', (error) => errors.push(error));
    caster.on('frame', (frame) => frames.push(frame));
    await caster.start();
    await caster.setOptions({ quality: 55, everyNthFrame: 2 });
    vi.advanceTimersByTime(200);
    await flush();
    const navigating = caster.rebind(first.page, identity(1, 1));
    await flush();
    if (phase === 'after-replacement') await navigating;
    if (outcome === 'reject') stopped.reject(new Error('Sample obsolete stop failure'));
    else stopped.resolve();
    await flush();
    detached.resolve();
    await navigating;
    expect(errors).toEqual([]);
    expect(next.session.send.mock.calls.filter(([method]) => method === 'Page.startScreencast')).toHaveLength(1);
    next.session.emit('Page.screencastFrame', { data: 'sample-replacement', sessionId: 6, metadata: {} });
    next.ack.resolve();
    await flush();
    expect(frames.at(-1)).toMatchObject({ page: identity(1, 1), data: 'sample-replacement' });
    await caster.dispatchInput({ kind: 'mouse', type: 'mouseMoved', x: 17, y: 25 });
    expect(next.session.send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ x: 17, y: 25 }));
    await caster.setOptions({ quality: 65, everyNthFrame: 3 });
    vi.advanceTimersByTime(200);
    await flush();
    expect(next.session.send).toHaveBeenLastCalledWith('Page.startScreencast', expect.objectContaining({ quality: 65, everyNthFrame: 3 }));
    expect(errors).toEqual([]);
    await caster.stop();
  });

  it('applies the newest overlapping options restart without replaying the older configuration', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const stopped = deferred<void>();
    const send = test.session.send.getMockImplementation()!;
    let stopCount = 0;
    test.session.send.mockImplementation((method) => method === 'Page.stopScreencast' && stopCount++ === 0 ? stopped.promise : send(method));
    const caster = new ScreenCaster(test.page, {}, identity());
    await caster.start();
    await caster.setOptions({ quality: 55 });
    vi.advanceTimersByTime(200);
    await flush();
    await caster.setOptions({ quality: 65 });
    vi.advanceTimersByTime(200);
    await flush();
    stopped.resolve();
    await flush();
    const starts = test.session.send.mock.calls.filter(([method]) => method === 'Page.startScreencast');
    expect(starts).toHaveLength(2);
    expect(starts.at(-1)).toEqual(['Page.startScreencast', expect.objectContaining({ quality: 65 })]);
    await caster.stop();
  });

  it.each(['Page.stopScreencast', 'Page.startScreencast'])('reports an options error from its still-current owner at %s', async (failingMethod) => {
    vi.useFakeTimers();
    const test = fixture();
    const caster = new ScreenCaster(test.page, {}, identity());
    const errors: Error[] = [];
    caster.on('error', (error) => errors.push(error));
    await caster.start();
    const send = test.session.send.getMockImplementation()!;
    const error = new Error('Sample current options failure');
    test.session.send.mockImplementation((method) => method === failingMethod ? Promise.reject<void>(error) : send(method));
    await caster.setOptions({ quality: 55 });
    vi.advanceTimersByTime(200);
    await flush();
    expect(errors).toEqual([error]);
    await caster.stop();
  });

  it('forwards manual mouse input directly to CDP without producing AI mouse observations', async () => {
    const test = fixture();
    const caster = new ScreenCaster(test.page, {}, identity());
    const inputs: unknown[] = [];
    caster.on('input', (input) => inputs.push(input));
    await caster.dispatchInput({ kind: 'mouse', type: 'mouseMoved', x: 17, y: 25 });
    expect(inputs).toEqual([]);
    await caster.start();
    await caster.dispatchInput({ kind: 'mouse', type: 'mouseMoved', x: 17, y: 25 });
    expect(test.session.send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ x: 17, y: 25, type: 'mouseMoved' }));
    expect(inputs).toEqual([expect.objectContaining({ event: { kind: 'mouse', type: 'mouseMoved', x: 17, y: 25 }, identity: identity(), page: test.page, seq: 1 })]);
    const send = test.session.send.getMockImplementation()!;
    test.session.send.mockImplementation((method) => method === 'Input.dispatchMouseEvent' ? Promise.reject<void>(new Error('Sample send failure')) : send(method));
    await expect(caster.dispatchInput({ kind: 'mouse', type: 'mousePressed', x: 17, y: 25 })).rejects.toThrow('Sample send failure');
    expect(inputs).toHaveLength(1);
    test.session.send.mockImplementation(send);
    caster.on('input', () => { throw new Error('Sample observer failure'); });
    await expect(caster.dispatchInput({ kind: 'text', text: 'Sample text' })).resolves.toBeUndefined();
    expect(inputs).toHaveLength(2);
    await caster.stop();
  });
});
