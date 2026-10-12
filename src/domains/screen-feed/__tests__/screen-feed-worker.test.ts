import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCREEN_POINTER_POLICY } from '@shared/screen-pointer';

import type { StreamControlMessage, StreamServerMessage } from '@shared/types/stream';
import {
  ScreenFeedWorker,
  type ScreenFeedWorkerEnvironment,
} from '../screen-feed-worker';
import type { ScreenWorkerOutgoingMessage } from '../worker-protocol';

class FakePort {
  onmessage: ((event: MessageEvent<StreamServerMessage>) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly sent: StreamControlMessage[] = [];
  readonly start = vi.fn();
  readonly close = vi.fn();

  postMessage(message: StreamControlMessage): void {
    this.sent.push(message);
  }

  emit(message: StreamServerMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<StreamServerMessage>);
  }
}

function fakeViewport() {
  const context = { drawImage: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
  } as unknown as OffscreenCanvas;
  return { canvas, context };
}

function frame(seq: number): Extract<StreamServerMessage, { type: 'frame' }> {
  return {
    type: 'frame',
    meta: {
      seq,
      browserId: 'browser-a',
      width: 1280,
      height: 720,
      timestamp: seq,
    },
    data: new Uint8Array([seq]),
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

function harness(clock?: () => number) {
  const outgoing: ScreenWorkerOutgoingMessage[] = [];
  const intervals: Array<{ callback: () => void; stopped: boolean }> = [];
  let now = 0;
  const decode = vi.fn<ScreenFeedWorkerEnvironment['decode']>();
  const environment: ScreenFeedWorkerEnvironment = {
    decode,
    unixNow: clock,
    now: () => {
      if (clock) return clock();
      now += 2;
      return now;
    },
    post: (message) => outgoing.push(message),
    startInterval: (callback) => {
      intervals.push({ callback, stopped: false });
      return intervals.length - 1;
    },
    stopInterval: (id) => {
      const interval = intervals[id];
      if (interval) interval.stopped = true;
    },
  };
  return {
    worker: new ScreenFeedWorker(environment),
    outgoing,
    intervals,
    decode,
  };
}

describe('ScreenFeedWorker', () => {
  it('decodes once, draws every visible viewport, and closes the bitmap once', async () => {
    const test = harness();
    const port = new FakePort();
    const first = fakeViewport();
    const second = fakeViewport();
    const hidden = fakeViewport();
    const bitmap = { width: 1280, height: 720, close: vi.fn() } as unknown as ImageBitmap;
    test.decode.mockResolvedValue(bitmap);

    test.worker.accept({
      type: 'init-feed',
      epoch: 1,
      streamPort: port as unknown as MessagePort,
      demand: { fps: 30, quality: 90 },
    });
    test.worker.accept({
      type: 'attach-viewport',
      epoch: 1,
      leaseId: 'inline',
      canvas: first.canvas,
      visible: true,
    });
    test.worker.accept({
      type: 'attach-viewport',
      epoch: 1,
      leaseId: 'fullscreen',
      canvas: second.canvas,
      visible: true,
    });
    test.worker.accept({
      type: 'attach-viewport',
      epoch: 1,
      leaseId: 'hidden',
      canvas: hidden.canvas,
      visible: false,
    });
    port.sent.length = 0;
    port.emit(frame(1));
    await settle();

    expect(test.decode).toHaveBeenCalledOnce();
    expect(first.context.drawImage).toHaveBeenCalledOnce();
    expect(second.context.drawImage).toHaveBeenCalledOnce();
    expect(hidden.context.drawImage).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(port.sent).toContainEqual({ type: 'ack' });
    expect(test.outgoing.filter((message) => message.type === 'viewport-ready')).toHaveLength(2);
    expect(test.outgoing).toContainEqual({
      type: 'frame-size',
      epoch: 1,
      width: 1280,
      height: 720,
    });
  });

  it('acks decode failures and reports real sequence, decode, and draw stats', async () => {
    const test = harness();
    const port = new FakePort();
    const viewport = fakeViewport();
    const bitmap = { width: 1280, height: 720, close: vi.fn() } as unknown as ImageBitmap;
    test.decode.mockResolvedValueOnce(bitmap).mockRejectedValueOnce(new Error('bad jpeg'));

    test.worker.accept({
      type: 'init-feed',
      epoch: 4,
      streamPort: port as unknown as MessagePort,
      demand: { fps: 30 },
    });
    test.worker.accept({
      type: 'attach-viewport',
      epoch: 4,
      leaseId: 'inline',
      canvas: viewport.canvas,
      visible: true,
    });
    port.sent.length = 0;
    port.emit(frame(1));
    await settle();
    port.emit(frame(3));
    await settle();
    test.intervals[0]!.callback();

    expect(port.sent.filter((message) => message.type === 'ack')).toHaveLength(2);
    expect(test.outgoing).toContainEqual({
      type: 'error',
      epoch: 4,
      fatal: false,
      failure: { code: 'decode-failed', retryable: false, detail: 'bad jpeg' },
    });
    expect(test.outgoing).toContainEqual({
      type: 'stats',
      epoch: 4,
      feed: {
        receivedFrames: 2,
        decodedFrames: 1,
        decodeFailures: 1,
        sequenceGaps: 1,
        decodedFps: 1,
        decodeMs: 2,
      },
      viewports: [{ leaseId: 'inline', visible: true, drawnFrames: 1 }],
    });
  });

  it('closes a decoded bitmap and acks when drawing fails', async () => {
    const test = harness();
    const port = new FakePort();
    const viewport = fakeViewport();
    const bitmap = { width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap;
    test.decode.mockResolvedValue(bitmap);
    viewport.context.drawImage.mockImplementation(() => {
      throw new Error('canvas lost');
    });

    test.worker.accept({
      type: 'init-feed',
      epoch: 2,
      streamPort: port as unknown as MessagePort,
      demand: { fps: 15 },
    });
    test.worker.accept({
      type: 'attach-viewport',
      epoch: 2,
      leaseId: 'inline',
      canvas: viewport.canvas,
      visible: true,
    });
    port.sent.length = 0;
    port.emit(frame(1));
    await settle();

    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(port.sent).toContainEqual({ type: 'ack' });
    expect(test.outgoing).toContainEqual({
      type: 'error',
      epoch: 2,
      fatal: false,
      failure: { code: 'decode-failed', retryable: false, detail: 'canvas lost' },
    });
  });

  it('retains retryable recovery after consecutive canvas draw failures and releases every bitmap', async () => {
    const test = harness();
    const port = new FakePort();
    const viewport = fakeViewport();
    viewport.context.drawImage.mockImplementation(() => { throw new Error('Sample canvas unavailable'); });
    const bitmaps = Array.from({ length: 5 }, () => ({ width: 800, height: 600, close: vi.fn() }) as unknown as ImageBitmap);
    for (const bitmap of bitmaps) test.decode.mockResolvedValueOnce(bitmap);
    test.worker.accept({ type: 'init-feed', epoch: 1, streamPort: port as unknown as MessagePort, demand: { fps: 30 } });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'sample', canvas: viewport.canvas, visible: true });
    for (let seq = 1; seq <= 5; seq += 1) { port.emit(frame(seq)); await settle(); }
    expect(test.outgoing.at(-1)).toMatchObject({ type: 'error', failure: { code: 'decode-stalled', retryable: true } });
    expect(port.sent.filter((message) => message.type === 'ack')).toHaveLength(5);
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledOnce();
    test.worker.accept({ type: 'close', epoch: 2 });
  });

  it('projects actual drawn page identities and drops a JPEG decode overtaken by navigation', async () => {
    const test = harness();
    const port = new FakePort();
    const viewport = fakeViewport();
    const hidden = fakeViewport();
    const bitmap = { width: 1600, height: 1200, close: vi.fn() } as unknown as ImageBitmap;
    let resolve!: (value: ImageBitmap) => void;
    test.decode.mockReturnValueOnce(new Promise<ImageBitmap>((yes) => { resolve = yes; })).mockResolvedValue(bitmap);
    test.worker.accept({ type: 'init-feed', epoch: 1, streamPort: port as unknown as MessagePort, demand: { fps: 30 } });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'sample-inline', canvas: viewport.canvas, visible: true });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'sample-hidden', canvas: hidden.canvas, visible: false });
    const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: null });
    port.emit({ ...frame(1), meta: { ...frame(1).meta, page } });
    const next = { ...page, navigationSequence: 1 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page: next, pointer: null });
    resolve(bitmap);
    await settle();
    expect(viewport.context.drawImage).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(port.sent.at(-1)).toEqual({ type: 'ack' });
    port.emit({ ...frame(2), meta: { ...frame(2).meta, width: 800, height: 600, page: next, mapping: { scale: 1.25, offsetX: 0, offsetY: 0 } } });
    await settle();
    expect(viewport.canvas.width).toBe(1600);
    expect(test.outgoing).toContainEqual({ type: 'viewport-frame', epoch: 1, leaseId: 'sample-inline',
      frame: { page: next, width: 800, height: 600, mapping: { scale: 1.25, offsetX: 0, offsetY: 0 }, timestamp: 2, seq: 2, scrollX: undefined, scrollY: undefined }, pointer: null });
    expect(test.outgoing.some((message) => message.type === 'viewport-frame' && message.leaseId === 'sample-hidden')).toBe(false);
    expect(hidden.context.drawImage).not.toHaveBeenCalled();
  });

  it('keeps a matching captured frame for a short click when navigation precedes its visible presentation', async () => {
    const test = harness();
    const port = new FakePort();
    const viewport = fakeViewport();
    const bitmap = { width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap;
    test.decode.mockResolvedValue(bitmap);
    test.worker.accept({ type: 'init-feed', epoch: 1, streamPort: port as unknown as MessagePort, demand: { fps: 30 } });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'sample', canvas: viewport.canvas, visible: true });
    const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: null });
    port.emit({ ...frame(1), meta: { ...frame(1).meta, page } });
    await settle();
    const source = { page, seq: 3, action: 'up' as const, x: 80, y: 120, buttons: 0, clickCount: 1, timestamp: Date.now(),
      press: { page, seq: 2, x: 80, y: 120, timestamp: Date.now(), clickCount: 1 } };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: source });
    const next = { ...page, navigationSequence: 1 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page: next, pointer: null });
    port.emit({ ...frame(2), meta: { ...frame(2).meta, page: next } });
    await settle();
    expect(viewport.context.drawImage).toHaveBeenCalledTimes(1);
  });

  it('keeps independent visible clocks and latest-frame backpressure while a hidden viewport never holds a bitmap', async () => {
    vi.useFakeTimers();
    const test = harness(Date.now);
    const port = new FakePort();
    const first = fakeViewport();
    const second = fakeViewport();
    const hidden = fakeViewport();
    const bitmaps = [1, 2, 3].map(() => ({ width: 800, height: 600, close: vi.fn() }) as unknown as ImageBitmap);
    for (const bitmap of bitmaps) test.decode.mockResolvedValueOnce(bitmap);
    test.worker.accept({ type: 'init-feed', epoch: 1, streamPort: port as unknown as MessagePort, demand: { fps: 30 } });
    for (const [id, viewport, visible] of [['first', first, true], ['second', second, true], ['hidden', hidden, false]] as const) {
      test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: id, canvas: viewport.canvas, visible });
    }
    const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: null });
    port.emit({ ...frame(1), meta: { ...frame(1).meta, page } });
    await settle();
    const pointer = { page, seq: 3, action: 'up' as const, x: 80, y: 120, buttons: 0, clickCount: 1,
      timestamp: Date.now(), press: { page, seq: 2, x: 80, y: 120, timestamp: Date.now(), clickCount: 1 } };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer });
    test.worker.accept({ type: 'pointer-presented', epoch: 1, leaseId: 'first', page, seq: 3, pressSeq: 2, at: Date.now() });
    vi.advanceTimersByTime(40);
    test.worker.accept({ type: 'pointer-presented', epoch: 1, leaseId: 'second', page, seq: 3, pressSeq: 2, at: Date.now() });
    vi.advanceTimersByTime(20);
    const next = { ...page, navigationSequence: 1 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page: next, pointer });
    for (const seq of [2, 3]) {
      port.emit({ ...frame(seq), meta: { ...frame(seq).meta, page: next } });
      await settle();
    }
    expect(bitmaps[1]!.close).toHaveBeenCalledOnce();
    expect(bitmaps[2]!.close).not.toHaveBeenCalled();
    expect(port.sent.filter((message) => message.type === 'ack')).toHaveLength(3);
    const latest = (leaseId: string) => test.outgoing.filter((message) => message.type === 'viewport-pointer' && message.leaseId === leaseId).at(-1) as Extract<ScreenWorkerOutgoingMessage, { type: 'viewport-pointer' }>;
    vi.advanceTimersByTime(120);
    expect(latest('first').pointer).toMatchObject({ page, framePage: page, press: undefined });
    expect(latest('second').pointer).not.toBeNull();
    test.worker.accept({ type: 'pointer-cleared', epoch: 1, leaseId: 'first', clearId: latest('first').clearId });
    expect(first.context.drawImage).toHaveBeenCalledTimes(2);
    expect(first.context.drawImage.mock.calls[1]![0]).toBe(bitmaps[2]);
    expect(second.context.drawImage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(40);
    test.worker.accept({ type: 'pointer-cleared', epoch: 1, leaseId: 'second', clearId: latest('second').clearId });
    expect(second.context.drawImage).toHaveBeenCalledTimes(2);
    expect(hidden.context.drawImage).not.toHaveBeenCalled();
    expect(bitmaps[2]!.close).toHaveBeenCalledOnce();
    test.worker.accept({ type: 'close', epoch: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores a resumed hidden viewport from a matching current canvas without waiting for a static page to repaint', async () => {
    const test = harness();
    const port = new FakePort();
    const visible = fakeViewport();
    const hidden = fakeViewport();
    test.decode.mockImplementation(async () => ({ width: 800, height: 600, close: vi.fn() }) as unknown as ImageBitmap);
    test.worker.accept({ type: 'init-feed', epoch: 1, streamPort: port as unknown as MessagePort, demand: { fps: 30 } });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'visible', canvas: visible.canvas, visible: true });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'hidden', canvas: hidden.canvas, visible: false });
    const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: null });
    port.emit({ ...frame(1), meta: { ...frame(1).meta, page } });
    await settle();
    const next = { ...page, navigationSequence: 1 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page: next, pointer: null });
    port.emit({ ...frame(2), meta: { ...frame(2).meta, page: next } });
    await settle();
    test.worker.accept({ type: 'update-demand', epoch: 1, demand: { fps: 30 },
      viewports: [{ leaseId: 'visible', visible: true }, { leaseId: 'hidden', visible: true }] });
    expect(hidden.context.drawImage).toHaveBeenCalledExactlyOnceWith(visible.canvas, 0, 0);
    expect(test.decode).toHaveBeenCalledTimes(2);
    expect(port.sent.filter((message) => message.type === 'ack')).toHaveLength(2);
    expect(test.outgoing).toContainEqual({ type: 'viewport-frame', epoch: 1, leaseId: 'hidden', frame: { page: next, width: 1280, height: 720, mapping: undefined, timestamp: 2, seq: 2, scrollX: undefined, scrollY: undefined }, pointer: null });
    test.worker.accept({ type: 'close', epoch: 2 });
  });

  it('restores a static image when every lease is replaced during the existing feed grace period', async () => {
    const test = harness();
    const port = new FakePort();
    const first = fakeViewport();
    const replacement = fakeViewport();
    test.decode.mockResolvedValue({ width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap);
    const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
    test.worker.accept({ type: 'init-feed', epoch: 1, streamPort: port as unknown as MessagePort, demand: { fps: 4 } });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'first', canvas: first.canvas, visible: true });
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: null });
    port.emit({ ...frame(1), meta: { ...frame(1).meta, page } });
    await settle();
    test.worker.accept({ type: 'detach-viewport', epoch: 1, leaseId: 'first' });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'replacement', canvas: replacement.canvas, visible: true });
    expect(replacement.context.drawImage).toHaveBeenCalledExactlyOnceWith(first.canvas, 0, 0);
    expect(test.decode).toHaveBeenCalledOnce();
    const next = { ...page, navigationSequence: 1 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page: next, pointer: null });
    test.worker.accept({ type: 'detach-viewport', epoch: 1, leaseId: 'replacement' });
    const navigated = fakeViewport();
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'navigated', canvas: navigated.canvas, visible: true });
    expect(navigated.context.drawImage).not.toHaveBeenCalled();
    test.worker.accept({ type: 'close', epoch: 2 });
  });

  it('gives a new visible lease the real current image and its own first-display clock', async () => {
    const test = harness();
    const port = new FakePort();
    const inline = fakeViewport();
    const fullscreen = fakeViewport();
    test.decode.mockResolvedValue({ width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap);
    test.worker.accept({ type: 'init-feed', epoch: 1, streamPort: port as unknown as MessagePort, demand: { fps: 30 } });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'inline', canvas: inline.canvas, visible: true });
    const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: null });
    port.emit({ ...frame(1), meta: { ...frame(1).meta, page } });
    await settle();
    const source = { page, seq: 3, action: 'up' as const, x: 80, y: 120, buttons: 0, clickCount: 1, timestamp: Date.now(),
      press: { page, seq: 2, x: 80, y: 120, timestamp: Date.now(), clickCount: 1 } };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: source });
    test.worker.accept({ type: 'pointer-presented', epoch: 1, leaseId: 'inline', page, seq: 3, pressSeq: 2, at: Date.now() });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'fullscreen', canvas: fullscreen.canvas, visible: true });
    expect(fullscreen.context.drawImage).toHaveBeenCalledExactlyOnceWith(inline.canvas, 0, 0);
    expect(test.outgoing.filter((message) => message.type === 'viewport-frame' && message.leaseId === 'fullscreen').at(-1))
      .toMatchObject({ pointer: { ...source, framePage: page, visibleAt: null, pressVisibleAt: null } });
    expect(test.decode).toHaveBeenCalledOnce();
    test.worker.accept({ type: 'close', epoch: 2 });
  });

  it('restores an idle position to late and resumed leases from a static canvas without reviving old click feedback', async () => {
    vi.useFakeTimers();
    const test = harness(Date.now);
    const port = new FakePort();
    const inline = fakeViewport();
    const hidden = fakeViewport();
    const late = fakeViewport();
    test.decode.mockResolvedValue({ width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap);
    test.worker.accept({ type: 'init-feed', epoch: 1, streamPort: port as unknown as MessagePort, demand: { fps: 30 } });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'inline', canvas: inline.canvas, visible: true });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'hidden', canvas: hidden.canvas, visible: false });
    const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
    const source = { page, seq: 3, action: 'up' as const, x: 80, y: 120, buttons: 0, clickCount: 1, timestamp: Date.now(),
      press: { page, seq: 2, x: 80, y: 120, timestamp: Date.now(), clickCount: 1 } };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: source });
    port.emit({ ...frame(1), meta: { ...frame(1).meta, page } });
    await settle();
    vi.advanceTimersByTime(6000);
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'late', canvas: late.canvas, visible: true });
    test.worker.accept({ type: 'update-demand', epoch: 1, demand: { fps: 30 }, viewports: [
      { leaseId: 'inline', visible: true }, { leaseId: 'hidden', visible: true }, { leaseId: 'late', visible: true },
    ] });
    for (const [id, viewport] of [['late', late], ['hidden', hidden]] as const) {
      expect(viewport.context.drawImage).toHaveBeenCalledExactlyOnceWith(inline.canvas, 0, 0);
      expect(test.outgoing.filter((message) => message.type === 'viewport-frame' && message.leaseId === id).at(-1))
        .toMatchObject({ pointer: { seq: 3, x: 80, y: 120, timestamp: source.timestamp, press: undefined } });
    }
    expect(test.decode).toHaveBeenCalledOnce();
    expect(port.sent.filter((message) => message.type === 'ack')).toHaveLength(1);
    test.worker.accept({ type: 'close', epoch: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('commits a new same-Page frame and static position together while clearing only the old press', async () => {
    vi.useFakeTimers();
    const test = harness(Date.now);
    const port = new FakePort();
    const viewport = fakeViewport();
    test.decode.mockImplementation(async () => ({ width: 800, height: 600, close: vi.fn() }) as unknown as ImageBitmap);
    test.worker.accept({ type: 'init-feed', epoch: 1, streamPort: port as unknown as MessagePort, demand: { fps: 30 } });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'sample', canvas: viewport.canvas, visible: true });
    const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
    const source = { page, seq: 3, action: 'up' as const, x: 80, y: 120, buttons: 0, clickCount: 1, timestamp: Date.now(),
      press: { page, seq: 2, x: 80, y: 120, timestamp: Date.now(), clickCount: 1 } };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: source });
    port.emit({ ...frame(1), meta: { ...frame(1).meta, page } });
    await settle();
    test.worker.accept({ type: 'pointer-presented', epoch: 1, leaseId: 'sample', page, seq: 3, pressSeq: 2, at: Date.now() });
    const next = { ...page, navigationSequence: 1 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page: next, pointer: source });
    port.emit({ ...frame(2), meta: { ...frame(2).meta, page: next, mapping: { scale: 1.25, offsetX: 0, offsetY: 4 } } });
    await settle();
    vi.advanceTimersByTime(SCREEN_POINTER_POLICY.navigationVisibleMs);
    const clear = test.outgoing.filter((message) => message.type === 'viewport-pointer').at(-1) as Extract<ScreenWorkerOutgoingMessage, { type: 'viewport-pointer' }>;
    expect(clear.pointer).toMatchObject({ page, framePage: page, press: undefined });
    test.worker.accept({ type: 'pointer-cleared', epoch: 1, leaseId: 'sample', clearId: clear.clearId });
    const committed = test.outgoing.filter((message) => message.type === 'viewport-frame').at(-1);
    expect(committed).toMatchObject({ frame: { page: next, mapping: { scale: 1.25, offsetX: 0, offsetY: 4 } },
      pointer: { page, framePage: next, seq: source.seq, timestamp: source.timestamp, x: 80, y: 120, press: undefined } });
    expect(viewport.context.drawImage).toHaveBeenCalledTimes(2);
    expect(port.sent.filter((message) => message.type === 'ack')).toHaveLength(2);
    test.worker.accept({ type: 'close', epoch: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops input during old-frame feedback and resumes only on the actually drawn current page', async () => {
    vi.useFakeTimers();
    const test = harness(Date.now);
    const port = new FakePort();
    const viewport = fakeViewport();
    test.decode.mockImplementation(async () => ({ width: 800, height: 600, close: vi.fn() }) as unknown as ImageBitmap);
    test.worker.accept({ type: 'init-feed', epoch: 1, streamPort: port as unknown as MessagePort, demand: { fps: 30 } });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'sample', canvas: viewport.canvas, visible: true });
    const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
    const next = { ...page, navigationSequence: 1 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: null });
    port.emit({ ...frame(1), meta: { ...frame(1).meta, page } });
    await settle();
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page,
      pointer: { page, seq: 3, action: 'up', x: 80, y: 120, buttons: 0, clickCount: 1, timestamp: Date.now(),
        press: { page, seq: 2, x: 80, y: 120, timestamp: Date.now(), clickCount: 1 } } });
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page: next, pointer: null });
    const input = { type: 'input' as const, epoch: 1, leaseId: 'sample', event: { kind: 'text' as const, text: 'Sample text' } };
    test.worker.accept(input);
    vi.advanceTimersByTime(SCREEN_POINTER_POLICY.navigationMaxDelayMs);
    const clear = test.outgoing.filter((message) => message.type === 'viewport-pointer').at(-1) as Extract<ScreenWorkerOutgoingMessage, { type: 'viewport-pointer' }>;
    test.worker.accept({ type: 'pointer-cleared', epoch: 1, leaseId: 'sample', clearId: clear.clearId });
    test.worker.accept(input);
    expect(port.sent.some((message) => message.type === 'input')).toBe(false);
    port.emit({ ...frame(2), meta: { ...frame(2).meta, page: next } });
    await settle();
    test.worker.accept(input);
    expect(port.sent.filter((message) => message.type === 'input')).toEqual([{ type: 'input', event: input.event }]);
    test.worker.accept({ type: 'close', epoch: 2 });
  });

  it.each(['hidden', 'detach', 'disconnect', 'close'])('releases pending navigation bitmaps and timers on %s', async (action) => {
    vi.useFakeTimers();
    const test = harness(Date.now);
    const port = new FakePort();
    const viewport = fakeViewport();
    const first = { width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap;
    const pending = { width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap;
    test.decode.mockResolvedValueOnce(first).mockResolvedValueOnce(pending);
    test.worker.accept({ type: 'init-feed', epoch: 1, streamPort: port as unknown as MessagePort, demand: { fps: 30 } });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'sample', canvas: viewport.canvas, visible: true });
    const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: null });
    port.emit({ ...frame(1), meta: { ...frame(1).meta, page } });
    await settle();
    const source = { page, seq: 3, action: 'up' as const, x: 80, y: 120, buttons: 0, clickCount: 1, timestamp: Date.now(),
      press: { page, seq: 2, x: 80, y: 120, timestamp: Date.now(), clickCount: 1 } };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer: source });
    const next = { ...page, navigationSequence: 1 };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page: next, pointer: null });
    port.emit({ ...frame(2), meta: { ...frame(2).meta, page: next } });
    await settle();
    if (action === 'hidden') test.worker.accept({ type: 'update-demand', epoch: 1, demand: { fps: 4 }, viewports: [{ leaseId: 'sample', visible: false }] });
    if (action === 'detach') test.worker.accept({ type: 'detach-viewport', epoch: 1, leaseId: 'sample' });
    if (action === 'disconnect') test.worker.accept({ type: 'disconnect-feed', epoch: 1 });
    if (action === 'close') test.worker.accept({ type: 'close', epoch: 2 });
    expect(pending.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    test.worker.accept({ type: 'close', epoch: 3 });
  });

  it('publishes actual new frame times to every viewport during target refresh while continuing to draw and close bitmaps', async () => {
    const test = harness();
    const port = new FakePort();
    const first = fakeViewport(), second = fakeViewport();
    const bitmaps = [1, 2, 3].map(() => ({ width: 800, height: 600, close: vi.fn() }) as unknown as ImageBitmap);
    for (const bitmap of bitmaps) test.decode.mockResolvedValueOnce(bitmap);
    test.worker.accept({ type: 'init-feed', epoch: 1, streamPort: port as unknown as MessagePort, demand: { fps: 30 } });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'sample-inline', canvas: first.canvas, visible: true });
    test.worker.accept({ type: 'attach-viewport', epoch: 1, leaseId: 'sample-fullscreen', canvas: second.canvas, visible: true });
    const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
    const pointer = { page, seq: 0, action: 'initialize' as const, x: 24, y: 24, buttons: 0, clickCount: 0, timestamp: 1, revision: 1,
      target: { page, seq: 2, timestamp: 1, kind: 'input' as const, actor: 'ai' as const, x: 130, y: 80,
        rect: { x: 80, y: 60, width: 100, height: 40 }, scrollX: 0, scrollY: 0, frameBefore: 1 } };
    port.emit({ type: 'screen-state', browserId: 'sample-browser', page, pointer });
    for (const seq of [1, 2, 3]) {
      port.emit({ ...frame(seq), meta: { ...frame(seq).meta, timestamp: 1, width: 800, height: 600, page, scrollX: 0, scrollY: 0 } });
      await settle();
    }
    for (const leaseId of ['sample-inline', 'sample-fullscreen']) {
      const drawn = test.outgoing.filter((message): message is Extract<ScreenWorkerOutgoingMessage, { type: 'viewport-frame' }> => message.type === 'viewport-frame' && message.leaseId === leaseId);
      expect(drawn.map((message) => message.frame.timestamp)).toEqual([1, 1, 1]);
      expect(drawn.map((message) => message.frame.seq)).toEqual([1, 2, 3]);
      expect(drawn.every((message) => message.pointer?.target?.seq === 2)).toBe(true);
    }
    expect(first.context.drawImage).toHaveBeenCalledTimes(3);
    expect(second.context.drawImage).toHaveBeenCalledTimes(3);
    expect(bitmaps.every((bitmap) => vi.mocked(bitmap.close).mock.calls.length === 1)).toBe(true);
    test.worker.accept({ type: 'close', epoch: 2 });
  });

  it('disconnects the current port, ignores stale frames, and confirms close', async () => {
    const test = harness();
    const oldPort = new FakePort();
    const newPort = new FakePort();
    const bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    test.decode.mockResolvedValue(bitmap);
    test.worker.accept({
      type: 'init-feed',
      epoch: 1,
      streamPort: oldPort as unknown as MessagePort,
      demand: { fps: 15 },
    });
    test.worker.accept({ type: 'disconnect-feed', epoch: 1 });
    expect(oldPort.sent).toContainEqual({ type: 'stop' });
    expect(oldPort.close).toHaveBeenCalledOnce();

    test.worker.accept({
      type: 'init-feed',
      epoch: 3,
      streamPort: newPort as unknown as MessagePort,
      demand: { fps: 30 },
    });
    oldPort.emit(frame(1));
    await settle();
    expect(test.decode).not.toHaveBeenCalled();

    test.worker.accept({ type: 'close', epoch: 4 });
    expect(newPort.sent).toContainEqual({ type: 'stop' });
    expect(newPort.close).toHaveBeenCalledOnce();
    expect(test.intervals[0]!.stopped).toBe(true);
    expect(test.outgoing.at(-1)).toEqual({ type: 'closed', epoch: 4 });
  });
});
