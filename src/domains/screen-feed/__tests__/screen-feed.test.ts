import { describe, expect, it, vi } from 'vitest';

import type { RemoteInputEvent } from '@shared/types/stream';
import {
  ScreenFeed,
  type ScreenFeedDependencies,
  type ScreenWorkerLike,
} from '../screen-feed';
import { createScreenFeedRegistry } from '../screen-feed-registry';
import type {
  ScreenWorkerIncomingMessage,
  ScreenWorkerOutgoingMessage,
} from '../worker-protocol';

class ManualScheduler {
  private readonly frames: Array<{ active: boolean; callback: () => void }> = [];
  private readonly delays: Array<{ active: boolean; delayMs: number; callback: () => void }> = [];

  readonly scheduleFrame = (callback: () => void): (() => void) => {
    const task = { active: true, callback };
    this.frames.push(task);
    return () => {
      task.active = false;
    };
  };

  readonly scheduleDelay = (callback: () => void, delayMs: number): (() => void) => {
    const task = { active: true, delayMs, callback };
    this.delays.push(task);
    return () => {
      task.active = false;
    };
  };

  flushFrames(): void {
    for (const task of this.frames.splice(0)) {
      if (!task.active) continue;
      task.active = false;
      task.callback();
    }
  }

  runDelay(delayMs: number): void {
    for (const task of this.delays) {
      if (!task.active || task.delayMs !== delayMs) continue;
      task.active = false;
      task.callback();
    }
  }
}

class FakeWorker implements ScreenWorkerLike {
  readonly incoming: ScreenWorkerIncomingMessage[] = [];
  readonly terminate = vi.fn();
  private readonly messageListeners = new Set<
    (event: MessageEvent<ScreenWorkerOutgoingMessage>) => void
  >();
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();

  postMessage(message: ScreenWorkerIncomingMessage): void {
    this.incoming.push(message);
  }

  addEventListener(
    type: 'message' | 'error',
    listener:
      | ((event: MessageEvent<ScreenWorkerOutgoingMessage>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.add(
        listener as (event: MessageEvent<ScreenWorkerOutgoingMessage>) => void,
      );
    } else this.errorListeners.add(listener as (event: ErrorEvent) => void);
  }

  emit(message: ScreenWorkerOutgoingMessage): void {
    const event = { data: message } as MessageEvent<ScreenWorkerOutgoingMessage>;
    for (const listener of this.messageListeners) listener(event);
  }
}

function fakePort() {
  return { close: vi.fn() } as unknown as MessagePort;
}

function fakeCanvas(options: { transferError?: Error } = {}): HTMLCanvasElement {
  return {
    transferControlToOffscreen: vi.fn(() => {
      if (options.transferError) throw options.transferError;
      return {} as OffscreenCanvas;
    }),
  } as unknown as HTMLCanvasElement;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function lastMessage<T extends ScreenWorkerIncomingMessage['type']>(
  worker: FakeWorker,
  type: T,
): Extract<ScreenWorkerIncomingMessage, { type: T }> {
  const message = [...worker.incoming].reverse().find((candidate) => candidate.type === type);
  if (!message) throw new Error(`Missing worker message: ${type}`);
  return message as Extract<ScreenWorkerIncomingMessage, { type: T }>;
}

function feedHarness() {
  const scheduler = new ManualScheduler();
  const worker = new FakeWorker();
  const ports = [fakePort(), fakePort(), fakePort()];
  const requestPort = vi.fn(async () => ports[requestPort.mock.calls.length - 1]!);
  const onCloseDegraded = vi.fn();
  const dependencies: ScreenFeedDependencies = {
    requestPort,
    createWorker: () => worker,
    scheduleFrame: scheduler.scheduleFrame,
    scheduleDelay: scheduler.scheduleDelay,
    onCloseDegraded,
  };
  return { scheduler, worker, ports, requestPort, onCloseDegraded, dependencies };
}

describe('ScreenFeedRegistry', () => {
  it('shares one worker and one upstream port across two viewport leases', async () => {
    const scheduler = new ManualScheduler();
    const worker = new FakeWorker();
    const requestPort = vi.fn(async () => fakePort());
    const createWorker = vi.fn(() => worker);
    const registry = createScreenFeedRegistry({
      requestPort,
      createWorker,
      scheduleFrame: scheduler.scheduleFrame,
      scheduleDelay: scheduler.scheduleDelay,
    });

    const inline = registry.acquireViewport({
      agentId: 'agent-a',
      browserId: 'browser-a',
      interactive: true,
      demand: { visible: true, fps: 15, quality: 70, maxWidth: 960, maxHeight: 640 },
    });
    const fullscreen = registry.acquireViewport({
      agentId: 'agent-a',
      browserId: 'browser-a',
      interactive: false,
      demand: { visible: true, fps: 30, quality: 90, maxWidth: 1920, maxHeight: 1080 },
    });
    inline.attach(fakeCanvas());
    fullscreen.attach(fakeCanvas());
    scheduler.flushFrames();
    await settle();

    expect(createWorker).toHaveBeenCalledOnce();
    expect(requestPort).toHaveBeenCalledOnce();
    expect(worker.incoming.filter((message) => message.type === 'attach-viewport')).toHaveLength(2);
    expect(lastMessage(worker, 'update-demand').demand).toEqual({
      fps: 30,
      quality: 90,
      maxWidth: 1920,
      maxHeight: 1080,
    });

    fullscreen.release();
    scheduler.flushFrames();
    expect(lastMessage(worker, 'update-demand').demand).toEqual({
      fps: 15,
      quality: 70,
      maxWidth: 960,
      maxHeight: 640,
    });

    inline.update({ visible: false, fps: 15, quality: 70, maxWidth: 960, maxHeight: 640 });
    scheduler.flushFrames();
    expect(lastMessage(worker, 'update-demand').demand).toEqual({
      fps: 4,
      quality: 70,
      maxWidth: 960,
      maxHeight: 640,
    });
  });

  it('keeps the feed through release grace and closes it after the final lease', async () => {
    const scheduler = new ManualScheduler();
    const worker = new FakeWorker();
    const registry = createScreenFeedRegistry({
      requestPort: vi.fn(async () => fakePort()),
      createWorker: () => worker,
      scheduleFrame: scheduler.scheduleFrame,
      scheduleDelay: scheduler.scheduleDelay,
    });
    const first = registry.acquireViewport({
      agentId: 'agent-a',
      browserId: 'browser-a',
      interactive: false,
      demand: { visible: true, fps: 30 },
    });
    first.release();

    const replacement = registry.acquireViewport({
      agentId: 'agent-a',
      browserId: 'browser-a',
      interactive: false,
      demand: { visible: true, fps: 30 },
    });
    scheduler.runDelay(120);
    expect(registry.activeFeedCount()).toBe(1);
    expect(worker.incoming.some((message) => message.type === 'close')).toBe(false);

    replacement.release();
    scheduler.runDelay(120);
    expect(registry.activeFeedCount()).toBe(0);
    const close = lastMessage(worker, 'close');
    worker.emit({ type: 'closed', epoch: close.epoch });
    await registry.close();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('replaces the feed when browserId changes and awaits both closes', async () => {
    const scheduler = new ManualScheduler();
    const workers = [new FakeWorker(), new FakeWorker()];
    const createWorker = vi.fn(() => workers[createWorker.mock.calls.length - 1]!);
    const registry = createScreenFeedRegistry({
      requestPort: vi.fn(async () => fakePort()),
      createWorker,
      scheduleFrame: scheduler.scheduleFrame,
      scheduleDelay: scheduler.scheduleDelay,
    });
    registry.acquireViewport({
      agentId: 'agent-a',
      browserId: 'browser-a',
      interactive: false,
      demand: { visible: true, fps: 15 },
    });
    registry.acquireViewport({
      agentId: 'agent-a',
      browserId: 'browser-b',
      interactive: false,
      demand: { visible: true, fps: 30 },
    });

    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(registry.activeFeedCount()).toBe(1);
    const oldClose = lastMessage(workers[0]!, 'close');
    workers[0]!.emit({ type: 'closed', epoch: oldClose.epoch });
    const closePromise = registry.close();
    const newClose = lastMessage(workers[1]!, 'close');
    workers[1]!.emit({ type: 'closed', epoch: newClose.epoch });
    await closePromise;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(workers[1]!.terminate).toHaveBeenCalledOnce();
  });
});

describe('ScreenFeed state machine', () => {
  it('disconnects immediately, fences stale messages, and reconnects on a new epoch', async () => {
    const test = feedHarness();
    const feed = new ScreenFeed('agent-a', 'browser-a', test.dependencies);
    const lease = feed.createLease(false, { visible: true, fps: 30 }, () => undefined);
    lease.attach(fakeCanvas());
    await settle();
    const firstEpoch = lastMessage(test.worker, 'init-feed').epoch;
    test.worker.emit({ type: 'feed-ready', epoch: firstEpoch });
    expect(lease.snapshot().phase).toBe('streaming');

    test.worker.emit({
      type: 'error',
      epoch: firstEpoch,
      fatal: false,
      failure: { code: 'stream-closed', retryable: true, detail: 'closed' },
    });
    expect(lease.snapshot().phase).toBe('retry-wait');
    expect(lastMessage(test.worker, 'disconnect-feed').epoch).toBe(firstEpoch);

    test.worker.emit({ type: 'feed-ready', epoch: firstEpoch });
    expect(lease.snapshot().phase).toBe('retry-wait');
    test.scheduler.runDelay(3_000);
    await settle();
    const nextEpoch = lastMessage(test.worker, 'init-feed').epoch;
    expect(nextEpoch).toBeGreaterThan(firstEpoch);
    expect(test.requestPort).toHaveBeenCalledTimes(2);
    test.worker.emit({ type: 'feed-ready', epoch: nextEpoch });
    expect(lease.snapshot().phase).toBe('streaming');
  });

  it('does not retry fatal failures', async () => {
    const test = feedHarness();
    const feed = new ScreenFeed('agent-a', 'browser-a', test.dependencies);
    const lease = feed.createLease(false, { visible: true, fps: 30 }, () => undefined);
    await settle();
    const epoch = lastMessage(test.worker, 'init-feed').epoch;
    test.worker.emit({
      type: 'error',
      epoch,
      fatal: true,
      failure: {
        code: 'offscreen-context-unavailable',
        retryable: false,
        detail: 'no context',
      },
    });

    expect(lease.snapshot()).toMatchObject({
      phase: 'terminal',
      failure: { code: 'offscreen-context-unavailable' },
    });
    test.scheduler.runDelay(3_000);
    await settle();
    expect(test.requestPort).toHaveBeenCalledOnce();
  });

  it('rotates only the failed viewport canvas and keeps the feed', async () => {
    const test = feedHarness();
    const feed = new ScreenFeed('agent-a', 'browser-a', test.dependencies);
    const failed = feed.createLease(false, { visible: true, fps: 15 }, () => undefined);
    expect(failed.attach(fakeCanvas({ transferError: new Error('already transferred') }))).toBe(
      'replace-canvas',
    );
    failed.release();
    const replacement = feed.createLease(false, { visible: true, fps: 15 }, () => undefined);
    expect(replacement.attach(fakeCanvas())).toBe('attached');
    await settle();

    expect(test.requestPort).toHaveBeenCalledOnce();
    expect(test.worker.incoming.filter((message) => message.type === 'attach-viewport')).toHaveLength(1);
    expect(replacement.snapshot().phase).not.toBe('terminal');
  });

  it('sends input only from a ready, visible, interactive lease', async () => {
    const test = feedHarness();
    const feed = new ScreenFeed('agent-a', 'browser-a', test.dependencies);
    const interactive = feed.createLease(true, { visible: true, fps: 30 }, () => undefined);
    const passive = feed.createLease(false, { visible: true, fps: 30 }, () => undefined);
    interactive.attach(fakeCanvas());
    passive.attach(fakeCanvas());
    await settle();
    const epoch = lastMessage(test.worker, 'init-feed').epoch;
    test.worker.emit({ type: 'feed-ready', epoch });
    test.worker.emit({ type: 'viewport-ready', epoch, leaseId: interactive.id });
    test.worker.emit({ type: 'viewport-ready', epoch, leaseId: passive.id });
    const input = { kind: 'text', text: 'hello' } satisfies RemoteInputEvent;

    passive.sendInput(input);
    interactive.sendInput(input);
    expect(test.worker.incoming.filter((message) => message.type === 'input')).toHaveLength(1);

    interactive.update({ visible: false, fps: 30 });
    interactive.sendInput(input);
    expect(test.worker.incoming.filter((message) => message.type === 'input')).toHaveLength(1);
  });

  it('terminates after a missing close acknowledgement and reports degraded close', async () => {
    const test = feedHarness();
    const feed = new ScreenFeed('agent-a', 'browser-a', test.dependencies);
    feed.createLease(false, { visible: true, fps: 30 }, () => undefined);
    const closing = feed.close();
    test.scheduler.runDelay(250);
    await closing;

    expect(test.worker.terminate).toHaveBeenCalledOnce();
    expect(test.onCloseDegraded).toHaveBeenCalledWith('agent-a', 'browser-a');
  });
});
