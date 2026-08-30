import { createUuid } from '@shared/utils/identifiers.js';

import type {
  ConnectWelcome,
  HostFrame,
} from '../../../shared/electron-contracts/protocol.js';
import { toPublicFault } from '../../capabilities/public-errors.js';
import { PublicOperationError } from '../../capabilities/public-errors.js';
import { isStreamTransfer, type TransferPort } from '../../capabilities/catalog.js';
import { decodeClientFrame, ProtocolDecodeError } from './protocol-codec.js';
import { PortRouter } from './port-router.js';
import { settleWithDeadline } from '../../runtime/lifecycle/deadline.js';

export interface HostMessageEvent {
  readonly data: unknown;
}

export interface HostMessagePort {
  postMessage(message: unknown, transfer?: readonly TransferPort[]): void;
  on(event: 'message', listener: (event: HostMessageEvent) => void): this;
  on(event: 'close', listener: () => void): this;
  start(): void;
  close(): void;
}

interface PendingRequest {
  readonly controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface ActiveSubscription {
  readonly dispose: () => void | Promise<void>;
  sequence: number;
}

const MAX_REQUEST_DEADLINE_MS = 5 * 60_000;
const SUBSCRIPTION_CLOSE_TIMEOUT_MS = 2_000;

export class WindowConnection {
  readonly id = createUuid();
  private readonly controller = new AbortController();
  private readonly requests = new Map<string, PendingRequest>();
  private readonly usedRequestIds = new Set<string>();
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly childPorts = new Set<TransferPort>();
  private closed = false;

  constructor(
    private readonly port: HostMessagePort,
    private readonly router: PortRouter,
    private readonly options: {
      generation: string;
      windowId: number;
      welcome: Omit<ConnectWelcome, 'connectionId'>;
      onClosed?: (connection: WindowConnection) => void;
    },
  ) {}

  start(): void {
    if (this.closed) throw new Error('Connection is closed');
    this.port.on('message', (event) => this.receive(event.data));
    this.port.on('close', () => void this.close('peer-closed'));
    this.port.start();
    this.send({
      kind: 'welcome',
      welcome: { ...this.options.welcome, connectionId: this.id },
    });
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort(reason);
    for (const pending of this.requests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.controller.abort(reason);
    }
    this.requests.clear();

    const subscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();
    await Promise.allSettled(subscriptions.map(({ dispose }) => settleWithDeadline(
      () => Promise.resolve().then(dispose),
      SUBSCRIPTION_CLOSE_TIMEOUT_MS,
    )));
    for (const port of this.childPorts) {
      try {
        port.close();
      } catch {
        // Continue closing every child stream even if one port is already invalid.
      }
    }
    this.childPorts.clear();

    try {
      this.port.postMessage({ kind: 'closed', reason } satisfies HostFrame);
    } catch {
      // The peer may already be gone.
    }
    try {
      this.port.close();
    } finally {
      try {
        this.options.onClosed?.(this);
      } catch {
        // Boundary cleanup must not resurrect or leak a closed connection.
      }
    }
  }

  snapshot(): {
    closed: boolean;
    pendingRequests: number;
    subscriptions: number;
    childPorts: number;
  } {
    return Object.freeze({
      closed: this.closed,
      pendingRequests: this.requests.size,
      subscriptions: this.subscriptions.size,
      childPorts: this.childPorts.size,
    });
  }

  private receive(value: unknown): void {
    if (this.closed) return;
    try {
      const frame = decodeClientFrame(value);
      switch (frame.kind) {
        case 'request':
          void this.handleRequest(frame);
          break;
        case 'cancel':
          this.cancel(frame.id, 'client-cancelled');
          break;
        case 'subscribe':
          void this.handleSubscribe(frame.id, frame.topic, frame.payload);
          break;
        case 'unsubscribe':
          void this.unsubscribe(frame.subscriptionId);
          break;
      }
    } catch (error) {
      if (error instanceof ProtocolDecodeError) {
        void this.close('protocol-error');
        return;
      }
      void this.close('connection-error');
    }
  }

  private async handleRequest(frame: Extract<ReturnType<typeof decodeClientFrame>, { kind: 'request' }>): Promise<void> {
    if (this.usedRequestIds.has(frame.id)) {
      this.send({ kind: 'fault', id: frame.id, fault: toPublicFault(
        new PublicOperationError('conflict', 'Request id has already been used'),
      ) });
      return;
    }
    this.usedRequestIds.add(frame.id);
    if (frame.deadlineAt !== undefined && frame.deadlineAt <= Date.now()) {
      this.send({
        kind: 'fault',
        id: frame.id,
        fault: {
          code: 'deadline-exceeded',
          message: 'The operation deadline elapsed',
          correlationId: createUuid(),
          retryable: false,
        },
      });
      return;
    }
    const controller = new AbortController();
    const pending: PendingRequest = { controller, settled: false };
    this.requests.set(frame.id, pending);
    const abortFromConnection = () => controller.abort(this.controller.signal.reason);
    this.controller.signal.addEventListener('abort', abortFromConnection, { once: true });

    if (frame.deadlineAt !== undefined) {
      const delay = Math.min(
        MAX_REQUEST_DEADLINE_MS,
        Math.max(0, frame.deadlineAt - Date.now()),
      );
      pending.timer = setTimeout(() => this.cancel(frame.id, 'deadline-exceeded'), delay);
    }

    const execution = Promise.resolve().then(() => this.router.request({
      generation: this.options.generation,
      connectionId: this.id,
      windowId: this.options.windowId,
      signal: controller.signal,
    }, frame.operation, frame.payload));
    const outcome = execution.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const aborted = new Promise<{ status: 'aborted'; reason: unknown }>((resolve) => {
      if (controller.signal.aborted) {
        resolve({ status: 'aborted', reason: controller.signal.reason });
        return;
      }
      controller.signal.addEventListener('abort', () => {
        resolve({ status: 'aborted', reason: controller.signal.reason });
      }, { once: true });
    });
    const result = await Promise.race([outcome, aborted]);
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    this.requests.delete(frame.id);
    this.controller.signal.removeEventListener('abort', abortFromConnection);
    if (this.closed) return;

    if (result.status === 'aborted') {
      const deadline = result.reason === 'deadline-exceeded';
      this.send({
        kind: 'fault',
        id: frame.id,
        fault: {
          code: deadline ? 'deadline-exceeded' : 'aborted',
          message: deadline ? 'The operation deadline elapsed' : 'The operation was cancelled',
          correlationId: createUuid(),
          retryable: false,
        },
      });
    } else if (result.status === 'rejected') {
      this.send({ kind: 'fault', id: frame.id, fault: toPublicFault(result.error) });
    } else if (isStreamTransfer(result.value)) {
      const stream = result.value;
      this.childPorts.add(stream.port);
      try {
        stream.port.on?.('close', () => this.childPorts.delete(stream.port));
      } catch {
        // Some transferred port implementations do not expose lifecycle events.
      }
      this.send(
        { kind: 'stream', id: frame.id, metadata: stream.metadata },
        [stream.port],
      );
    } else {
      this.send({ kind: 'result', id: frame.id, value: result.value });
    }
  }

  private cancel(id: string, reason: string): void {
    const pending = this.requests.get(id);
    if (!pending || pending.settled) return;
    pending.controller.abort(reason);
  }

  private async handleSubscribe(id: string, topic: string, payload: unknown): Promise<void> {
    if (this.usedRequestIds.has(id)) {
      this.send({
        kind: 'fault',
        id,
        fault: toPublicFault(new PublicOperationError('conflict', 'Request id has already been used')),
      });
      return;
    }
    this.usedRequestIds.add(id);
    const subscriptionId = createUuid();
    const queued: unknown[] = [];
    let active: ActiveSubscription | undefined;
    const emit = (change: unknown): void => {
      if (this.closed) return;
      if (!active) {
        queued.push(change);
        return;
      }
      this.publishChange(subscriptionId, active, change);
    };

    try {
      const opened = await this.router.subscribe({
        generation: this.options.generation,
        connectionId: this.id,
        windowId: this.options.windowId,
        signal: this.controller.signal,
      }, topic, payload, emit);
      if (this.closed) {
        await opened.dispose();
        return;
      }
      active = { dispose: opened.dispose, sequence: 0 };
      this.subscriptions.set(subscriptionId, active);
      this.send({
        kind: 'subscribed',
        id,
        subscriptionId,
        snapshot: opened.snapshot,
        cursor: opened.cursor ?? '0',
      });
      for (const change of queued) this.publishChange(subscriptionId, active, change);
    } catch (error) {
      this.send({ kind: 'fault', id, fault: toPublicFault(error) });
    }
  }

  private publishChange(
    subscriptionId: string,
    subscription: ActiveSubscription,
    value: unknown,
  ): void {
    subscription.sequence += 1;
    this.send({
      kind: 'change',
      subscriptionId,
      sequence: subscription.sequence,
      value,
      cursor: String(subscription.sequence),
    });
  }

  private async unsubscribe(subscriptionId: string): Promise<void> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    this.subscriptions.delete(subscriptionId);
    await Promise.resolve().then(subscription.dispose).catch(() => undefined);
  }

  private send(frame: HostFrame, transfer?: readonly TransferPort[]): void {
    if (this.closed && frame.kind !== 'closed') return;
    try {
      this.port.postMessage(frame, transfer);
    } catch {
      if (!this.closed) void this.close('send-failed');
    }
  }
}
