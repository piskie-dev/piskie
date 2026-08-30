/// <reference lib="webworker" />

import type { StreamControlMessage, StreamServerMessage } from '@shared/types/stream';
import type {
  AggregateScreenDemand,
  ScreenFeedFailure,
  ScreenFeedStats,
  ScreenWorkerIncomingMessage,
  ScreenWorkerOutgoingMessage,
} from './worker-protocol';

const MAX_CONSECUTIVE_DECODE_FAILURES = 5;

export interface ScreenFeedWorkerEnvironment {
  readonly decode: (data: Uint8Array) => Promise<ImageBitmap>;
  readonly now: () => number;
  readonly post: (message: ScreenWorkerOutgoingMessage) => void;
  readonly startInterval: (callback: () => void, delayMs: number) => number;
  readonly stopInterval: (id: number) => void;
}

interface Viewport {
  readonly id: string;
  readonly canvas: OffscreenCanvas;
  readonly context: OffscreenCanvasRenderingContext2D;
  visible: boolean;
  ready: boolean;
  drawnFrames: number;
}

export class ScreenFeedWorker {
  private epoch = 0;
  private port: MessagePort | null = null;
  private demand: AggregateScreenDemand = { fps: 4 };
  private readonly viewports = new Map<string, Viewport>();
  private statsTimer: number | null = null;
  private receivedFrames = 0;
  private decodedFrames = 0;
  private decodeFailures = 0;
  private sequenceGaps = 0;
  private intervalDecoded = 0;
  private intervalDecodeMs = 0;
  private lastSequence: number | null = null;
  private consecutiveDecodeFailures = 0;
  private lastFrameSize: { width: number; height: number } | null = null;

  constructor(private readonly environment: ScreenFeedWorkerEnvironment) {}

  accept(message: ScreenWorkerIncomingMessage): void {
    switch (message.type) {
      case 'init-feed':
        this.initialize(message.epoch, message.streamPort, message.demand);
        break;
      case 'attach-viewport':
        this.attach(message.epoch, message.leaseId, message.canvas, message.visible);
        break;
      case 'detach-viewport':
        if (message.epoch < this.epoch) return;
        if (message.epoch > this.epoch && this.port === null) this.epoch = message.epoch;
        if (message.epoch === this.epoch) this.viewports.delete(message.leaseId);
        break;
      case 'disconnect-feed':
        this.disconnect(message.epoch);
        break;
      case 'update-demand': {
        if (message.epoch !== this.epoch) return;
        this.demand = message.demand;
        const activeLeaseIds = new Set(message.viewports.map((item) => item.leaseId));
        for (const leaseId of this.viewports.keys()) {
          if (!activeLeaseIds.has(leaseId)) this.viewports.delete(leaseId);
        }
        for (const item of message.viewports) {
          const viewport = this.viewports.get(item.leaseId);
          if (viewport) viewport.visible = item.visible;
        }
        this.sendDemand();
        break;
      }
      case 'input': {
        if (message.epoch !== this.epoch) return;
        const viewport = this.viewports.get(message.leaseId);
        if (viewport?.visible) this.postControl({ type: 'input', event: message.event });
        break;
      }
      case 'close':
        this.shutdown(message.epoch);
        break;
    }
  }

  protocolError(message: string): void {
    this.post({
      type: 'error',
      epoch: this.epoch,
      fatal: true,
      failure: { code: 'worker-protocol-invalid', retryable: false, detail: message },
    });
  }

  private initialize(epoch: number, port: MessagePort, demand: AggregateScreenDemand): void {
    if (epoch < this.epoch) {
      port.close();
      return;
    }
    this.closePort();
    this.epoch = epoch;
    this.port = port;
    this.demand = demand;
    this.lastSequence = null;
    this.lastFrameSize = null;
    this.consecutiveDecodeFailures = 0;
    for (const viewport of this.viewports.values()) viewport.ready = false;

    port.onmessage = (event: MessageEvent<StreamServerMessage>) => {
      this.handleServerMessage(epoch, event.data);
    };
    port.onmessageerror = () => {
      this.postError(epoch, {
        code: 'stream-closed',
        retryable: true,
      });
    };
    port.start();
    this.sendDemand();
    this.startStats();
  }

  private attach(
    epoch: number,
    leaseId: string,
    canvas: OffscreenCanvas,
    visible: boolean,
  ): void {
    if (epoch < this.epoch) return;
    if (epoch > this.epoch && this.port === null) this.epoch = epoch;
    const context = canvas.getContext('2d');
    if (!context) {
      this.post({
        type: 'error',
        epoch: this.epoch,
        fatal: true,
        failure: {
          code: 'offscreen-context-unavailable',
          retryable: false,
        },
      });
      return;
    }
    this.viewports.set(leaseId, {
      id: leaseId,
      canvas,
      context,
      visible,
      ready: false,
      drawnFrames: 0,
    });
  }

  private disconnect(epoch: number): void {
    if (epoch !== this.epoch) return;
    this.closePort();
    for (const viewport of this.viewports.values()) viewport.ready = false;
  }

  private handleServerMessage(epoch: number, message: StreamServerMessage): void {
    if (epoch !== this.epoch) return;
    switch (message.type) {
      case 'started':
        this.post({ type: 'feed-ready', epoch });
        break;
      case 'error':
        this.postError(epoch, message.failure);
        break;
      case 'frame':
        void this.drawFrame(epoch, message);
        break;
    }
  }

  private async drawFrame(
    epoch: number,
    message: Extract<StreamServerMessage, { type: 'frame' }>,
  ): Promise<void> {
    if (epoch !== this.epoch) return;
    this.receivedFrames += 1;
    if (this.lastSequence !== null && message.meta.seq > this.lastSequence + 1) {
      this.sequenceGaps += message.meta.seq - this.lastSequence - 1;
    }
    this.lastSequence = message.meta.seq;
    const startedAt = this.environment.now();
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await this.environment.decode(message.data);
      if (epoch !== this.epoch || this.port === null) return;
      const width = message.meta.width ?? bitmap.width;
      const height = message.meta.height ?? bitmap.height;
      this.postFrameSize(width, height);

      for (const viewport of this.viewports.values()) {
        if (!viewport.visible) continue;
        if (viewport.canvas.width !== bitmap.width || viewport.canvas.height !== bitmap.height) {
          viewport.canvas.width = bitmap.width;
          viewport.canvas.height = bitmap.height;
        }
        viewport.context.drawImage(bitmap, 0, 0);
        viewport.drawnFrames += 1;
        if (!viewport.ready) {
          viewport.ready = true;
          this.post({ type: 'viewport-ready', epoch, leaseId: viewport.id });
        }
      }
      const decodeMs = this.environment.now() - startedAt;
      this.decodedFrames += 1;
      this.intervalDecoded += 1;
      this.intervalDecodeMs += decodeMs;
      this.consecutiveDecodeFailures = 0;
    } catch (error) {
      this.decodeFailures += 1;
      this.consecutiveDecodeFailures += 1;
      const stalled = this.consecutiveDecodeFailures >= MAX_CONSECUTIVE_DECODE_FAILURES;
      this.post({
        type: 'error',
        epoch,
        fatal: false,
        failure: {
          code: stalled ? 'decode-stalled' : 'decode-failed',
          retryable: stalled,
          detail: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      bitmap?.close();
      if (epoch === this.epoch && this.port !== null) this.postControl({ type: 'ack' });
    }
  }

  private postFrameSize(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    if (this.lastFrameSize?.width === width && this.lastFrameSize.height === height) return;
    this.lastFrameSize = { width, height };
    this.post({ type: 'frame-size', epoch: this.epoch, width, height });
  }

  private sendDemand(): void {
    this.postControl({ type: 'set-fps', fps: this.demand.fps });
    this.postControl({
      type: 'set-quality',
      ...(this.demand.quality !== undefined ? { quality: this.demand.quality } : {}),
      ...(this.demand.maxWidth !== undefined ? { maxWidth: this.demand.maxWidth } : {}),
      ...(this.demand.maxHeight !== undefined ? { maxHeight: this.demand.maxHeight } : {}),
    });
  }

  private postControl(message: StreamControlMessage): void {
    try {
      this.port?.postMessage(message);
    } catch {
      this.postError(this.epoch, {
        code: 'stream-closed',
        retryable: true,
      });
    }
  }

  private postError(epoch: number, failure: ScreenFeedFailure): void {
    this.post({ type: 'error', epoch, failure, fatal: false });
  }

  private startStats(): void {
    if (this.statsTimer !== null) return;
    this.statsTimer = this.environment.startInterval(() => {
      const feed: ScreenFeedStats = {
        receivedFrames: this.receivedFrames,
        decodedFrames: this.decodedFrames,
        decodeFailures: this.decodeFailures,
        sequenceGaps: this.sequenceGaps,
        decodedFps: this.intervalDecoded,
        decodeMs: this.intervalDecoded > 0
          ? Number((this.intervalDecodeMs / this.intervalDecoded).toFixed(2))
          : 0,
      };
      this.post({
        type: 'stats',
        epoch: this.epoch,
        feed,
        viewports: [...this.viewports.values()].map((viewport) => ({
          leaseId: viewport.id,
          visible: viewport.visible,
          drawnFrames: viewport.drawnFrames,
        })),
      });
      this.intervalDecoded = 0;
      this.intervalDecodeMs = 0;
    }, 1_000);
  }

  private closePort(): void {
    const port = this.port;
    this.port = null;
    if (!port) return;
    try {
      port.postMessage({ type: 'stop' } satisfies StreamControlMessage);
    } catch {
      // The upstream is already gone.
    }
    port.close();
  }

  private shutdown(epoch: number): void {
    this.epoch = epoch;
    this.closePort();
    if (this.statsTimer !== null) {
      this.environment.stopInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.viewports.clear();
    this.post({ type: 'closed', epoch });
  }

  private post(message: ScreenWorkerOutgoingMessage): void {
    this.environment.post(message);
  }
}

export function createBrowserScreenFeedWorker(scope: DedicatedWorkerGlobalScope): ScreenFeedWorker {
  return new ScreenFeedWorker({
    decode: (data) => createImageBitmap(new Blob([data as BlobPart], { type: 'image/jpeg' })),
    now: () => performance.now(),
    post: (message) => scope.postMessage(message),
    startInterval: (callback, delayMs) => scope.setInterval(callback, delayMs) as unknown as number,
    stopInterval: (id) => scope.clearInterval(id),
  });
}
