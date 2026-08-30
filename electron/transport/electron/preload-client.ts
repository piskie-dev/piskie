import { createUuid } from '@shared/utils/identifiers.js';
import { ipcRenderer } from 'electron';
import {
  PiskieFault,
  ELECTRON_CONNECT_CHANNEL,
  ELECTRON_PROTOCOL_VERSION,
  type ConnectWelcome,
} from '../../../shared/electron-contracts/index.js';
import { decodeHostFrame } from './protocol-codec.js';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
  expectsStream: boolean;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

interface ClientSubscription {
  readonly topic: string;
  readonly payload?: unknown;
  requestId?: string;
  subscriptionId?: string;
  disposed: boolean;
  expectedSequence: number;
  onSnapshot?(snapshot: unknown): void;
  onChange(change: unknown): void;
  onError?(error: unknown): void;
}

export interface StreamResponse {
  readonly port: MessagePort;
  readonly metadata?: unknown;
}

export interface SubscribeOptions<Snapshot, Change> {
  readonly payload?: unknown;
  readonly onSnapshot?: (snapshot: Snapshot) => void;
  readonly onChange: (change: Change) => void;
  readonly onError?: (error: unknown) => void;
}

export class ElectronPreloadClient {
  private readonly rootPort: MessagePort;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly subscriptionsByRequest = new Map<string, ClientSubscription>();
  private readonly subscriptionsById = new Map<string, ClientSubscription>();
  private readonly welcomePromise: Promise<ConnectWelcome>;
  private resolveWelcome!: (welcome: ConnectWelcome) => void;
  private rejectWelcome!: (error: unknown) => void;
  private nextId = 0;
  private welcome?: ConnectWelcome;
  private closed = false;

  constructor(options: {
    rendererBuildId: string;
    windowNonce?: string;
    connectTimeoutMs?: number;
  }) {
    const channel = new MessageChannel();
    this.rootPort = channel.port1;
    this.welcomePromise = new Promise<ConnectWelcome>((resolve, reject) => {
      this.resolveWelcome = resolve;
      this.rejectWelcome = reject;
    });
    this.rootPort.onmessage = (event) => this.receive(event);
    this.rootPort.onmessageerror = () => this.close(new Error('Desktop connection message error'));
    this.rootPort.start();

    const timeout = setTimeout(() => {
      this.close(new Error('Desktop connection timed out'));
    }, options.connectTimeoutMs ?? 10_000);
    void this.welcomePromise.finally(() => clearTimeout(timeout)).catch(() => undefined);

    ipcRenderer.postMessage(ELECTRON_CONNECT_CHANNEL, {
      protocolVersion: ELECTRON_PROTOCOL_VERSION,
      rendererBuildId: options.rendererBuildId,
      windowNonce: options.windowNonce ?? createUuid(),
    }, [channel.port2]);
  }

  connected(): Promise<ConnectWelcome> {
    return this.welcomePromise;
  }

  request<T>(
    operation: string,
    args: readonly unknown[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.sendRequest<T>(operation, args, false, options) as Promise<T>;
  }

  requestStream(
    operation: string,
    args: readonly unknown[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<StreamResponse> {
    return this.sendRequest(operation, args, true, options) as Promise<StreamResponse>;
  }

  subscribe<Snapshot, Change>(
    topic: string,
    options: SubscribeOptions<Snapshot, Change>,
  ): () => void {
    const subscription: ClientSubscription = {
      topic,
      payload: options.payload,
      disposed: false,
      expectedSequence: 0,
      onSnapshot: options.onSnapshot as ((snapshot: unknown) => void) | undefined,
      onChange: options.onChange as (change: unknown) => void,
      onError: options.onError,
    };
    void this.connected().then(() => {
      if (subscription.disposed) return;
      this.openSubscription(subscription);
    }).catch((error) => this.notifySubscriptionError(subscription, error));

    return () => {
      if (subscription.disposed) return;
      subscription.disposed = true;
      if (subscription.subscriptionId) {
        this.subscriptionsById.delete(subscription.subscriptionId);
        if (!this.closed) {
          this.rootPort.postMessage({
            kind: 'unsubscribe',
            subscriptionId: subscription.subscriptionId,
          });
        }
      } else if (!subscription.requestId) {
        // No subscribe frame was sent, so there is no host resource to release.
        return;
      }
    };
  }

  close(reason: unknown = new Error('Desktop connection closed')): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectWelcome(reason);
    for (const request of this.requests.values()) {
      this.cleanupRequest(request);
      request.reject(reason);
    }
    this.requests.clear();
    const subscriptions = new Set([
      ...this.subscriptionsById.values(),
      ...this.subscriptionsByRequest.values(),
    ]);
    for (const subscription of subscriptions) {
      if (!subscription.disposed) this.notifySubscriptionError(subscription, reason);
      subscription.disposed = true;
    }
    this.subscriptionsById.clear();
    this.subscriptionsByRequest.clear();
    this.rootPort.close();
  }

  private async sendRequest<T>(
    operation: string,
    args: readonly unknown[],
    expectsStream: boolean,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T | StreamResponse> {
    await this.connected();
    if (this.closed) throw new Error('Desktop connection is closed');
    if (options.signal?.aborted) throw abortError();
    const id = this.id('r');
    const timeoutMs = options.timeoutMs ?? 30_000;

    return new Promise<T | StreamResponse>((resolve, reject) => {
      const request: PendingRequest = {
        resolve,
        reject,
        expectsStream,
      };
      if (timeoutMs > 0) {
        request.timer = setTimeout(() => {
          this.sendCancel(id);
        }, timeoutMs);
      }
      this.requests.set(id, request);
      if (options.signal) {
        const cancel = (): void => this.sendCancel(id);
        request.abortSignal = options.signal;
        request.abortListener = cancel;
        options.signal.addEventListener('abort', cancel, { once: true });
      }
      try {
        this.rootPort.postMessage({
          kind: 'request',
          id,
          operation,
          payload: [...args],
          ...(timeoutMs > 0 && { deadlineAt: Date.now() + timeoutMs }),
        });
      } catch (error) {
        this.close(error);
      }
    });
  }

  private receive(event: MessageEvent): void {
    let frame: ReturnType<typeof decodeHostFrame>;
    try {
      frame = decodeHostFrame(event.data);
    } catch (error) {
      this.close(error);
      return;
    }
    switch (frame.kind) {
      case 'welcome':
        if (this.welcome || frame.welcome.protocolVersion !== ELECTRON_PROTOCOL_VERSION) {
          this.close(new Error('Invalid desktop welcome'));
          return;
        }
        this.welcome = frame.welcome;
        this.resolveWelcome(frame.welcome);
        return;
      case 'result':
        this.settleRequest(frame.id, (request) => {
          if (request.expectsStream) throw new Error('Expected a stream port');
          request.resolve(frame.value);
        });
        return;
      case 'stream':
        if (!this.requests.has(frame.id)) {
          event.ports[0]?.close();
          return;
        }
        this.settleRequest(frame.id, (request) => {
          if (!request.expectsStream) {
            event.ports[0]?.close();
            throw new Error('Received an unexpected stream port');
          }
          if (!event.ports[0]) throw new Error('Missing stream port');
          request.resolve({ port: event.ports[0], metadata: frame.metadata });
        });
        return;
      case 'fault': {
        const request = this.requests.get(frame.id);
        if (request) {
          this.settleRequest(frame.id, (pending) => pending.reject(new PiskieFault(frame.fault)));
          return;
        }
        const subscription = this.subscriptionsByRequest.get(frame.id);
        if (subscription) {
          this.subscriptionsByRequest.delete(frame.id);
          subscription.requestId = undefined;
          subscription.disposed = true;
          this.notifySubscriptionError(subscription, new PiskieFault(frame.fault));
        }
        return;
      }
      case 'subscribed': {
        const subscription = this.subscriptionsByRequest.get(frame.id);
        if (!subscription) return;
        this.subscriptionsByRequest.delete(frame.id);
        subscription.requestId = undefined;
        if (subscription.disposed) {
          try {
            this.rootPort.postMessage({ kind: 'unsubscribe', subscriptionId: frame.subscriptionId });
          } catch (error) {
            this.close(error);
          }
          return;
        }
        subscription.subscriptionId = frame.subscriptionId;
        this.subscriptionsById.set(frame.subscriptionId, subscription);
        this.notifySubscriptionSnapshot(subscription, frame.snapshot);
        return;
      }
      case 'change': {
        const subscription = this.subscriptionsById.get(frame.subscriptionId);
        if (!subscription || subscription.disposed) return;
        if (frame.sequence !== subscription.expectedSequence + 1) {
          this.subscriptionsById.delete(frame.subscriptionId);
          subscription.subscriptionId = undefined;
          try {
            this.rootPort.postMessage({ kind: 'unsubscribe', subscriptionId: frame.subscriptionId });
          } catch (error) {
            this.close(error);
            return;
          }
          this.notifySubscriptionError(subscription, new Error('Subscription sequence gap'));
          this.openSubscription(subscription);
          return;
        }
        subscription.expectedSequence = frame.sequence;
        this.notifySubscriptionChange(subscription, frame.value);
        return;
      }
      case 'closed':
        this.close(new Error(`Desktop connection closed: ${frame.reason}`));
        return;
    }
  }

  private settleRequest(id: string, settle: (request: PendingRequest) => void): void {
    const request = this.requests.get(id);
    if (!request) return;
    this.requests.delete(id);
    this.cleanupRequest(request);
    try {
      settle(request);
    } catch (error) {
      request.reject(error);
    }
  }

  private id(prefix: 'r' | 's'): string {
    this.nextId += 1;
    return `${prefix}-${this.nextId.toString(36)}-${createUuid()}`;
  }

  private openSubscription(subscription: ClientSubscription): void {
    if (this.closed || subscription.disposed || subscription.requestId) return;
    const requestId = this.id('s');
    subscription.requestId = requestId;
    subscription.expectedSequence = 0;
    this.subscriptionsByRequest.set(requestId, subscription);
    try {
      this.rootPort.postMessage({
        kind: 'subscribe',
        id: requestId,
        topic: subscription.topic,
        payload: subscription.payload,
      });
    } catch (error) {
      this.close(error);
    }
  }

  private sendCancel(id: string): void {
    if (this.closed || !this.requests.has(id)) return;
    try {
      this.rootPort.postMessage({ kind: 'cancel', id });
    } catch (error) {
      this.close(error);
    }
  }

  private cleanupRequest(request: PendingRequest): void {
    if (request.timer) clearTimeout(request.timer);
    if (request.abortSignal && request.abortListener) {
      request.abortSignal.removeEventListener('abort', request.abortListener);
    }
  }

  private notifySubscriptionSnapshot(subscription: ClientSubscription, snapshot: unknown): void {
    if (!subscription.onSnapshot) return;
    try {
      subscription.onSnapshot(snapshot);
    } catch (error) {
      this.notifySubscriptionError(subscription, error);
    }
  }

  private notifySubscriptionChange(subscription: ClientSubscription, change: unknown): void {
    try {
      subscription.onChange(change);
    } catch (error) {
      this.notifySubscriptionError(subscription, error);
    }
  }

  private notifySubscriptionError(subscription: ClientSubscription, error: unknown): void {
    try {
      subscription.onError?.(error);
    } catch {
      // Renderer observer failures are isolated from the transport connection.
    }
  }
}

function abortError(): Error {
  const error = new Error('The operation was cancelled');
  error.name = 'AbortError';
  return error;
}
