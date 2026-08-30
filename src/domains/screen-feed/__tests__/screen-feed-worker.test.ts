import { describe, expect, it, vi } from 'vitest';

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

function harness() {
  const outgoing: ScreenWorkerOutgoingMessage[] = [];
  const intervals: Array<{ callback: () => void; stopped: boolean }> = [];
  let now = 0;
  const decode = vi.fn<ScreenFeedWorkerEnvironment['decode']>();
  const environment: ScreenFeedWorkerEnvironment = {
    decode,
    now: () => {
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
