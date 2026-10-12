/// <reference lib="webworker" />

import { sameScreenPage, type StreamControlMessage, type StreamServerMessage } from '@shared/types/stream';
import type {
  AggregateScreenDemand,
  ScreenFeedFailure,
  ScreenFeedStats,
  ScreenWorkerIncomingMessage,
  ScreenWorkerOutgoingMessage,
  ScreenViewportFrame,
} from './worker-protocol';

import { ScreenPointerPresentation } from './screen-pointer-presentation';

const MAX_CONSECUTIVE_DECODE_FAILURES = 5;

interface DecodedFrame {
  readonly bitmap: ImageBitmap;
  readonly frame: ScreenViewportFrame;
  readonly remaining: Set<string>;
}

export interface ScreenFeedWorkerEnvironment {
  readonly decode: (data: Uint8Array) => Promise<ImageBitmap>;
  readonly now: () => number;
  readonly unixNow?: () => number;
  readonly scheduleDelay?: (callback: () => void, delayMs: number) => () => void;
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
  frame: ScreenViewportFrame | null;
  readonly presentation: ScreenPointerPresentation;
}

export class ScreenFeedWorker {
  private epoch = 0;
  private pendingFrame: DecodedFrame | null = null;
  /** Real painted pixels survive lease replacement only for this feed's existing lifetime. */
  private lastPicture: { canvas: OffscreenCanvas; frame: ScreenViewportFrame } | null = null;
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
  private screenState: Extract<StreamServerMessage, { type: 'screen-state' }> | null = null;

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
        if (message.epoch === this.epoch) this.detach(message.leaseId);
        break;
      case 'disconnect-feed':
        this.disconnect(message.epoch);
        break;
      case 'update-demand': {
        if (message.epoch !== this.epoch) return;
        this.demand = message.demand;
        const activeLeaseIds = new Set(message.viewports.map((item) => item.leaseId));
        for (const leaseId of this.viewports.keys()) {
          if (!activeLeaseIds.has(leaseId)) this.detach(leaseId);
        }
        for (const item of message.viewports) {
          const viewport = this.viewports.get(item.leaseId);
          if (viewport) {
            const becomingVisible = !viewport.visible && item.visible;
            viewport.visible = item.visible;
            viewport.presentation.setVisible(item.visible);
            if (becomingVisible) this.restoreViewport(viewport);
            if (!item.visible) this.pendingFrame?.remaining.delete(item.leaseId);
          }
        }
        this.flushPendingFrame();
        this.sendDemand();        break;
      }
      case 'input': {
        if (message.epoch !== this.epoch) return;
        const viewport = this.viewports.get(message.leaseId);
        if (viewport?.visible && !viewport.presentation.blocked
          && (!this.screenState || sameScreenPage(viewport.frame?.page, this.screenState.page))) {
          this.postControl({ type: 'input', event: message.event });
        }
        break;
      }
      case 'pointer-presented':
        if (message.epoch === this.epoch) this.viewports.get(message.leaseId)?.presentation.presented(message.page, message.seq, message.pressSeq, message.at, message.targetSeq, message.activitySeq);
        break;
      case 'pointer-cleared':
        if (message.epoch === this.epoch) this.viewports.get(message.leaseId)?.presentation.cleared(message.clearId);
        break;
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
    this.clearPendingFrame();
    this.epoch = epoch;
    this.port = port;
    this.demand = demand;
    this.lastSequence = null;
    this.lastFrameSize = null;
    this.screenState = null;
    this.lastPicture = null;
    this.consecutiveDecodeFailures = 0;
    for (const viewport of this.viewports.values()) {
      viewport.ready = false;
      viewport.frame = null;
      viewport.presentation.reset();
    }

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
    this.detach(leaseId);
    const presentation = new ScreenPointerPresentation(visible, {
      now: this.environment.now,
      unixNow: this.environment.unixNow ?? Date.now,
      scheduleDelay: this.environment.scheduleDelay ?? ((callback, delayMs) => {
        const id = setTimeout(callback, delayMs);
        return () => clearTimeout(id);
      }),
      publish: () => {
        const frame = this.viewports.get(leaseId)?.frame;
        this.post({ type: 'viewport-pointer', epoch: this.epoch, leaseId,
          pointer: presentation.pointer, clearId: presentation.clearId,
          ...(frame && (presentation.pointer?.target?.frameAfter !== undefined || presentation.pointer?.target?.frameBefore !== undefined) ? { frame } : {}) });
      },
      resume: () => this.flushPendingFrame(),
    });
    this.viewports.set(leaseId, {
      id: leaseId,
      canvas,
      context,
      visible,
      ready: false,
      drawnFrames: 0,
      frame: null,
      presentation,
    });
    if (this.screenState) presentation.accept(this.screenState.page, this.screenState.pointer);
    this.restoreViewport(this.viewports.get(leaseId)!);
  }

  private disconnect(epoch: number): void {
    if (epoch !== this.epoch) return;
    this.closePort();
    this.clearPendingFrame();
    this.screenState = null;
    this.lastPicture = null;
    for (const viewport of this.viewports.values()) {
      viewport.ready = false;
      viewport.frame = null;
      viewport.presentation.reset();
    }
  }

  private handleServerMessage(epoch: number, message: StreamServerMessage): void {
    if (epoch !== this.epoch) return;
    switch (message.type) {
      case 'started':
        this.post({ type: 'feed-ready', epoch });
        break;
      case 'screen-state':
        this.screenState = message;
        this.post({ type: 'screen-state', epoch, page: message.page, pointer: message.pointer });
        for (const viewport of this.viewports.values()) viewport.presentation.accept(message.page, message.pointer);
        if (this.pendingFrame && !sameScreenPage(this.pendingFrame.frame.page, message.page)) this.clearPendingFrame();
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
      // A page reset can overtake an in-flight JPEG decode or queued port frame.
      if (this.screenState && !sameScreenPage(message.meta.page, this.screenState.page)) return;
      const width = message.meta.width ?? bitmap.width;
      const height = message.meta.height ?? bitmap.height;
      this.postFrameSize(width, height);

      this.clearPendingFrame();
      this.pendingFrame = { bitmap,
        frame: { page: message.meta.page ?? null, width, height, mapping: message.meta.mapping,
          timestamp: message.meta.timestamp, seq: message.meta.seq, scrollX: message.meta.scrollX, scrollY: message.meta.scrollY },
        remaining: new Set([...this.viewports.values()].filter((viewport) => viewport.visible).map((viewport) => viewport.id)) };
      bitmap = null; // The one latest decoded frame owns this bitmap until drawn or replaced.
      if (!this.flushPendingFrame()) return;
      const decodeMs = this.environment.now() - startedAt;
      this.decodedFrames += 1;
      this.intervalDecoded += 1;
      this.intervalDecodeMs += decodeMs;
      this.consecutiveDecodeFailures = 0;
    } catch (error) {
      this.reportDecodeFailure(epoch, error);
    } finally {
      bitmap?.close();
      if (epoch === this.epoch && this.port !== null) this.postControl({ type: 'ack' });
    }
  }

  private reportDecodeFailure(epoch: number, error: unknown): void {
    this.decodeFailures += 1;
    this.consecutiveDecodeFailures += 1;
    const stalled = this.consecutiveDecodeFailures >= MAX_CONSECUTIVE_DECODE_FAILURES;
    this.post({ type: 'error', epoch, fatal: false,
      failure: { code: stalled ? 'decode-stalled' : 'decode-failed', retryable: stalled,
        detail: error instanceof Error ? error.message : String(error) } });
  }

  private flushPendingFrame(): boolean {
    const pending = this.pendingFrame;
    if (!pending) return true;
    let drawn = true;
    for (const leaseId of pending.remaining) {
      const viewport = this.viewports.get(leaseId);
      if (!viewport || !viewport.visible) { pending.remaining.delete(leaseId); continue; }
      if (!viewport.presentation.canDraw(pending.frame.page)) continue;
      if (!this.drawViewport(viewport, pending.bitmap, pending.frame)) drawn = false;
      pending.remaining.delete(leaseId);
    }
    if (pending.remaining.size === 0) this.clearPendingFrame();
    return drawn;
  }

  private restoreViewport(viewport: Viewport): void {
    if (!viewport.visible || viewport.presentation.blocked || !this.screenState?.page) return;
    // Reuse a real current canvas when a static page has no new screencast frame.
    const source = [...this.viewports.values()].find((other) => other !== viewport && other.visible && other.ready
      && sameScreenPage(other.frame?.page, this.screenState?.page));
    const picture = source?.frame ? { canvas: source.canvas, frame: source.frame } : this.lastPicture;
    if (picture && sameScreenPage(picture.frame.page, this.screenState.page)
      && viewport.presentation.canDraw(picture.frame.page)) {
      this.drawViewport(viewport, picture.canvas, picture.frame);
    }
  }

  private drawViewport(viewport: Viewport, image: ImageBitmap | OffscreenCanvas, frame: ScreenViewportFrame): boolean {
    if (viewport.canvas.width !== image.width || viewport.canvas.height !== image.height) {
      viewport.canvas.width = image.width;
      viewport.canvas.height = image.height;
    }
    try {
      viewport.context.drawImage(image, 0, 0);
    } catch (error) {
      this.reportDecodeFailure(this.epoch, error);
      return false;
    }
    this.lastPicture = { canvas: viewport.canvas, frame };
    viewport.drawnFrames += 1;
    const after = viewport.presentation.pointer?.target?.frameAfter;
    const reachedTargetFrame = after !== undefined && (viewport.frame?.timestamp ?? 0) < after && (frame.timestamp ?? 0) >= after;
    const refreshingTarget = viewport.presentation.pointer?.target?.frameBefore !== undefined
      && (viewport.frame?.timestamp !== frame.timestamp || viewport.frame?.seq !== frame.seq);
    const frameChanged = !sameViewportFrame(viewport.frame, frame) || reachedTargetFrame || refreshingTarget;
    const previousPointer = viewport.presentation.pointer;
    viewport.frame = frame;
    const pointer = viewport.presentation.drawn(frame.page);
    if (frameChanged || pointer !== previousPointer) {
      this.post({ type: 'viewport-frame', epoch: this.epoch, leaseId: viewport.id, frame, pointer });
    }
    if (!viewport.ready) {
      viewport.ready = true;
      this.post({ type: 'viewport-ready', epoch: this.epoch, leaseId: viewport.id });
    }
    return true;
  }

  private clearPendingFrame(): void {
    this.pendingFrame?.bitmap.close();
    this.pendingFrame = null;
  }

  private detach(leaseId: string): void {
    this.viewports.get(leaseId)?.presentation.dispose();
    this.viewports.delete(leaseId);
    this.pendingFrame?.remaining.delete(leaseId);
    if (this.pendingFrame?.remaining.size === 0) this.clearPendingFrame();
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
    this.clearPendingFrame();
    for (const viewport of this.viewports.values()) viewport.presentation.dispose();
    this.viewports.clear();
    this.lastPicture = null;
    this.post({ type: 'closed', epoch });
  }

  private post(message: ScreenWorkerOutgoingMessage): void {
    this.environment.post(message);
  }
}

function sameViewportFrame(left: ScreenViewportFrame | null, right: ScreenViewportFrame): boolean {
  return !!left && (left.page === right.page || sameScreenPage(left.page, right.page))
    && left.width === right.width && left.height === right.height
    && left.scrollX === right.scrollX && left.scrollY === right.scrollY
    && left.mapping?.scale === right.mapping?.scale
    && left.mapping?.offsetX === right.mapping?.offsetX
    && left.mapping?.offsetY === right.mapping?.offsetY;
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
