import type { RemoteInputEvent } from '@shared/types/stream';
import {
  ScreenStreamPortError,
  type BrowserStreamOptions,
} from '@/services/screen-stream-port';
import type {
  AggregateScreenDemand,
  ScreenFeedFailure,
  ScreenFeedStats,
  ScreenWorkerIncomingMessage,
  ScreenWorkerOutgoingMessage,
  ViewportDemand,
} from './worker-protocol';

const BACKGROUND_FPS = 4;
const RETRY_DELAY_MS = 3_000;
const CLOSE_ACK_TIMEOUT_MS = 250;

export type ScreenFeedPhase =
  | 'idle'
  | 'requesting-port'
  | 'connecting-worker'
  | 'streaming'
  | 'retry-wait'
  | 'terminal'
  | 'closing'
  | 'closed';

export interface ScreenFeedSnapshot {
  readonly phase: ScreenFeedPhase;
  readonly epoch: number;
  readonly failure: ScreenFeedFailure | null;
  readonly frameSize: { readonly width: number; readonly height: number } | null;
  readonly stats: ScreenFeedStats;
  readonly demand: AggregateScreenDemand;
}

export interface ViewportSnapshot extends ScreenFeedSnapshot {
  readonly ready: boolean;
  readonly viewportFailure: ScreenFeedFailure | null;
  readonly drawnFrames: number;
}

export type ViewportAttachResult = 'attached' | 'same' | 'replace-canvas' | 'fatal';

export interface ViewportLease {
  readonly id: string;
  attach(canvas: HTMLCanvasElement): ViewportAttachResult;
  update(demand: ViewportDemand): void;
  sendInput(event: RemoteInputEvent): void;
  subscribe(listener: () => void): () => void;
  snapshot(): ViewportSnapshot;
  release(): void;
}

export interface ScreenWorkerLike {
  postMessage(message: ScreenWorkerIncomingMessage, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ScreenWorkerOutgoingMessage>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export interface ScreenFeedDependencies {
  readonly requestPort: (options: BrowserStreamOptions) => Promise<MessagePort>;
  readonly createWorker: () => ScreenWorkerLike;
  readonly scheduleFrame: (callback: () => void) => () => void;
  readonly scheduleDelay: (callback: () => void, delayMs: number) => () => void;
  readonly onCloseDegraded?: (agentId: string, browserId: string) => void;
}

const EMPTY_STATS: ScreenFeedStats = Object.freeze({
  receivedFrames: 0,
  decodedFrames: 0,
  decodeFailures: 0,
  sequenceGaps: 0,
  decodedFps: 0,
  decodeMs: 0,
});

interface LeaseRecord {
  readonly id: string;
  readonly interactive: boolean;
  demand: ViewportDemand;
  canvas: HTMLCanvasElement | null;
  attached: boolean;
  released: boolean;
  ready: boolean;
  viewportFailure: ScreenFeedFailure | null;
  drawnFrames: number;
  snapshot: ViewportSnapshot;
  readonly listeners: Set<() => void>;
  readonly onRelease: () => void;
}

export class ScreenFeed {
  readonly agentId: string;
  readonly browserId: string;
  private readonly worker: ScreenWorkerLike;
  private readonly leases = new Map<string, LeaseRecord>();
  private phase: ScreenFeedPhase = 'idle';
  private epoch = 0;
  private failure: ScreenFeedFailure | null = null;
  private frameSize: ScreenFeedSnapshot['frameSize'] = null;
  private stats: ScreenFeedStats = EMPTY_STATS;
  private demand: AggregateScreenDemand = { fps: BACKGROUND_FPS };
  private cancelDemandFrame: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  private closePromise: Promise<void> | null = null;
  private finishClose: (() => void) | null = null;
  private cancelCloseTimeout: (() => void) | null = null;
  private nextLease = 1;
  private accepting = true;

  constructor(
    agentId: string,
    browserId: string,
    private readonly dependencies: ScreenFeedDependencies,
  ) {
    this.agentId = agentId;
    this.browserId = browserId;
    this.worker = dependencies.createWorker();
    this.worker.addEventListener('message', (event) => this.handleWorkerMessage(event.data));
    this.worker.addEventListener('error', (event) => {
      this.enterTerminal({
        code: 'worker-crashed',
        retryable: false,
        ...(event.message ? { detail: event.message } : {}),
      });
    });
  }

  leaseCount(): number {
    return this.leases.size;
  }

  createLease(
    interactive: boolean,
    initialDemand: ViewportDemand,
    onRelease: () => void,
  ): ViewportLease {
    if (!this.accepting) throw new Error('ScreenFeed is closing');
    const id = `viewport-${this.nextLease++}`;
    const record: LeaseRecord = {
      id,
      interactive,
      demand: normalizeDemand(initialDemand),
      canvas: null,
      attached: false,
      released: false,
      ready: false,
      viewportFailure: null,
      drawnFrames: 0,
      snapshot: undefined as unknown as ViewportSnapshot,
      listeners: new Set(),
      onRelease,
    };
    record.snapshot = this.viewportSnapshot(record);
    this.leases.set(id, record);
    this.queueDemandUpdate();
    if (this.phase === 'idle') this.connect();

    return {
      id,
      attach: (canvas) => this.attach(record, canvas),
      update: (demand) => {
        if (record.released) return;
        const normalized = normalizeDemand(demand);
        if (sameDemand(record.demand, normalized)) return;
        record.demand = normalized;
        this.refreshLease(record);
        this.queueDemandUpdate();
      },
      sendInput: (event) => {
        if (
          record.released
          || !record.interactive
          || !record.demand.visible
          || !record.ready
          || this.phase !== 'streaming'
        ) return;
        this.post({ type: 'input', epoch: this.epoch, leaseId: record.id, event });
      },
      subscribe: (listener) => {
        record.listeners.add(listener);
        return () => record.listeners.delete(listener);
      },
      snapshot: () => record.snapshot,
      release: () => this.release(record),
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    this.cancelDemandFrame?.();
    this.cancelDemandFrame = null;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.phase = 'closing';
    this.failure = null;
    this.epoch += 1;
    const closeEpoch = this.epoch;
    this.refreshAll();

    this.closePromise = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (degraded: boolean) => {
        if (finished) return;
        finished = true;
        this.cancelCloseTimeout?.();
        this.cancelCloseTimeout = null;
        this.finishClose = null;
        this.worker.terminate();
        this.phase = 'closed';
        if (degraded) this.dependencies.onCloseDegraded?.(this.agentId, this.browserId);
        this.refreshAll();
        resolve();
      };
      this.finishClose = () => finish(false);
      this.cancelCloseTimeout = this.dependencies.scheduleDelay(
        () => finish(true),
        CLOSE_ACK_TIMEOUT_MS,
      );
      this.post({ type: 'close', epoch: closeEpoch });
    });
    return this.closePromise;
  }

  private attach(record: LeaseRecord, canvas: HTMLCanvasElement): ViewportAttachResult {
    if (record.released) return 'fatal';
    if (record.canvas === canvas && record.attached) return 'same';
    if (record.attached) return 'replace-canvas';
    if (typeof canvas.transferControlToOffscreen !== 'function') {
      const failure: ScreenFeedFailure = {
        code: 'offscreen-unavailable',
        retryable: false,
      };
      record.viewportFailure = failure;
      this.enterTerminal(failure);
      return 'fatal';
    }
    let offscreen: OffscreenCanvas;
    try {
      offscreen = canvas.transferControlToOffscreen();
    } catch (error) {
      record.viewportFailure = {
        code: 'canvas-transfer-failed',
        retryable: false,
        detail: error instanceof Error ? error.message : String(error),
      };
      this.refreshLease(record);
      return 'replace-canvas';
    }
    record.canvas = canvas;
    record.attached = true;
    record.viewportFailure = null;
    this.post({
      type: 'attach-viewport',
      epoch: this.epoch,
      leaseId: record.id,
      canvas: offscreen,
      visible: record.demand.visible,
    }, [offscreen]);
    this.refreshLease(record);
    return 'attached';
  }

  private release(record: LeaseRecord): void {
    if (record.released) return;
    record.released = true;
    record.listeners.clear();
    this.leases.delete(record.id);
    if (record.attached && this.phase !== 'closed') {
      this.post({ type: 'detach-viewport', epoch: this.epoch, leaseId: record.id });
    }
    this.queueDemandUpdate();
    record.onRelease();
  }

  private connect(): void {
    if (!this.accepting || this.leases.size === 0) return;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.epoch += 1;
    const epoch = this.epoch;
    this.phase = 'requesting-port';
    this.failure = null;
    for (const lease of this.leases.values()) lease.ready = false;
    this.refreshAll();
    const demand = this.aggregateDemand();
    this.demand = demand;
    void this.dependencies.requestPort({ browserId: this.browserId, ...demand })
      .then((port) => {
        if (!this.accepting || epoch !== this.epoch) {
          port.close();
          return;
        }
        this.phase = 'connecting-worker';
        this.refreshAll();
        this.post({ type: 'init-feed', epoch, streamPort: port, demand }, [port]);
        this.flushDemand();
      })
      .catch((error) => {
        if (!this.accepting || epoch !== this.epoch) return;
        this.scheduleRetry({
          code: error instanceof ScreenStreamPortError
            ? error.code === 'timeout'
              ? 'port-request-timeout'
              : 'port-response-missing'
            : 'port-request-failed',
          retryable: true,
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private scheduleRetry(failure: ScreenFeedFailure): void {
    if (!this.accepting || this.phase === 'closing' || this.phase === 'closed') return;
    if (!failure.retryable) {
      this.enterTerminal(failure);
      return;
    }
    this.cancelRetry?.();
    this.disconnectAttempt();
    this.phase = 'retry-wait';
    this.failure = failure;
    for (const lease of this.leases.values()) lease.ready = false;
    this.refreshAll();
    this.cancelRetry = this.dependencies.scheduleDelay(() => {
      this.cancelRetry = null;
      this.connect();
    }, RETRY_DELAY_MS);
  }

  private enterTerminal(failure: ScreenFeedFailure): void {
    if (this.phase === 'closing' || this.phase === 'closed') return;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.disconnectAttempt();
    this.phase = 'terminal';
    this.failure = failure;
    for (const lease of this.leases.values()) lease.ready = false;
    this.refreshAll();
  }

  private queueDemandUpdate(): void {
    if (this.cancelDemandFrame) return;
    this.cancelDemandFrame = this.dependencies.scheduleFrame(() => {
      this.cancelDemandFrame = null;
      this.flushDemand();
    });
  }

  private flushDemand(): void {
    if (this.phase === 'closed' || this.phase === 'closing') return;
    const next = this.aggregateDemand();
    const changed = !sameAggregateDemand(this.demand, next);
    if (changed) this.demand = next;
    const viewports = [...this.leases.values()].map((lease) => ({
      leaseId: lease.id,
      visible: lease.demand.visible,
    }));
    this.post({ type: 'update-demand', epoch: this.epoch, demand: next, viewports });
    if (changed) this.refreshAll();
  }

  private disconnectAttempt(): void {
    const attemptEpoch = this.epoch;
    try {
      this.worker.postMessage({ type: 'disconnect-feed', epoch: attemptEpoch });
    } catch {
      // The feed is already transitioning to a non-streaming state.
    }
    this.epoch += 1;
  }

  private aggregateDemand(): AggregateScreenDemand {
    const all = [...this.leases.values()];
    const visible = all.filter((lease) => lease.demand.visible);
    const source = visible.length > 0 ? visible : all;
    return {
      fps: visible.length > 0
        ? maxDefined(source.map((lease) => lease.demand.fps)) ?? BACKGROUND_FPS
        : BACKGROUND_FPS,
      ...optionalMax('quality', source),
      ...optionalMax('maxWidth', source),
      ...optionalMax('maxHeight', source),
    };
  }

  private handleWorkerMessage(message: ScreenWorkerOutgoingMessage): void {
    if (message.epoch !== this.epoch) return;
    switch (message.type) {
      case 'feed-ready':
        this.phase = 'streaming';
        this.failure = null;
        this.refreshAll();
        break;
      case 'viewport-ready': {
        const lease = this.leases.get(message.leaseId);
        if (!lease) return;
        lease.ready = true;
        lease.viewportFailure = null;
        this.refreshLease(lease);
        break;
      }
      case 'frame-size':
        this.frameSize = { width: message.width, height: message.height };
        this.refreshAll();
        break;
      case 'stats':
        this.stats = message.feed;
        for (const viewport of message.viewports) {
          const lease = this.leases.get(viewport.leaseId);
          if (lease) lease.drawnFrames = viewport.drawnFrames;
        }
        this.refreshAll();
        break;
      case 'error':
        if (!message.fatal && message.failure.code === 'decode-failed') break;
        if (message.fatal || !message.failure.retryable) {
          this.enterTerminal(message.failure);
        } else this.scheduleRetry(message.failure);
        break;
      case 'closed':
        if (this.phase === 'closing') this.finishClose?.();
        break;
    }
  }

  private viewportSnapshot(record: LeaseRecord): ViewportSnapshot {
    return {
      phase: this.phase,
      epoch: this.epoch,
      failure: this.failure,
      frameSize: this.frameSize,
      stats: this.stats,
      demand: this.demand,
      ready: record.ready && this.phase === 'streaming',
      viewportFailure: record.viewportFailure,
      drawnFrames: record.drawnFrames,
    };
  }

  private refreshAll(): void {
    for (const lease of this.leases.values()) this.refreshLease(lease);
  }

  private refreshLease(record: LeaseRecord): void {
    const next = this.viewportSnapshot(record);
    if (sameViewportSnapshot(record.snapshot, next)) return;
    record.snapshot = next;
    for (const listener of record.listeners) listener();
  }

  private post(message: ScreenWorkerIncomingMessage, transfer?: Transferable[]): void {
    try {
      this.worker.postMessage(message, transfer);
    } catch (error) {
      if (this.phase !== 'closing' && this.phase !== 'closed') {
        this.enterTerminal({
          code: 'worker-protocol-invalid',
          retryable: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function normalizeDemand(demand: ViewportDemand): ViewportDemand {
  return {
    visible: demand.visible,
    fps: Math.max(1, Math.min(60, Math.round(demand.fps))),
    ...(demand.quality !== undefined ? { quality: demand.quality } : {}),
    ...(demand.maxWidth !== undefined ? { maxWidth: demand.maxWidth } : {}),
    ...(demand.maxHeight !== undefined ? { maxHeight: demand.maxHeight } : {}),
  };
}

function sameDemand(left: ViewportDemand, right: ViewportDemand): boolean {
  return left.visible === right.visible
    && left.fps === right.fps
    && left.quality === right.quality
    && left.maxWidth === right.maxWidth
    && left.maxHeight === right.maxHeight;
}

function sameAggregateDemand(left: AggregateScreenDemand, right: AggregateScreenDemand): boolean {
  return left.fps === right.fps
    && left.quality === right.quality
    && left.maxWidth === right.maxWidth
    && left.maxHeight === right.maxHeight;
}

function maxDefined(values: readonly (number | undefined)[]): number | undefined {
  let maximum: number | undefined;
  for (const value of values) {
    if (value !== undefined && (maximum === undefined || value > maximum)) maximum = value;
  }
  return maximum;
}

function optionalMax<K extends 'quality' | 'maxWidth' | 'maxHeight'>(
  key: K,
  leases: readonly LeaseRecord[],
): Partial<Pick<AggregateScreenDemand, K>> {
  const value = maxDefined(leases.map((lease) => lease.demand[key]));
  return value === undefined ? {} : { [key]: value } as Pick<AggregateScreenDemand, K>;
}

function sameViewportSnapshot(left: ViewportSnapshot, right: ViewportSnapshot): boolean {
  return left.phase === right.phase
    && left.epoch === right.epoch
    && left.failure === right.failure
    && left.frameSize === right.frameSize
    && left.stats === right.stats
    && left.demand === right.demand
    && left.ready === right.ready
    && left.viewportFailure === right.viewportFailure
    && left.drawnFrames === right.drawnFrames;
}
