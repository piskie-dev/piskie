import WebSocket, { type RawData } from 'ws';

export type ComfySocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => WebSocket;

export type ComfySocketItem =
  | { kind: 'json'; value: unknown; raw: string }
  | { kind: 'invalid_json'; raw: string; cause: unknown }
  | { kind: 'binary'; bytes: Uint8Array }
  | { kind: 'error'; cause: unknown }
  | { kind: 'closed'; code: number; reason: string };

const MAX_QUEUED_MESSAGES = 128;

export function defaultComfySocketFactory(
  url: string,
  headers: Readonly<Record<string, string>>,
): WebSocket {
  return new WebSocket(url, { headers: { ...headers } });
}

export class ComfySocketSession {
  private readonly queue: ComfySocketItem[] = [];
  private waiter: ((item: ComfySocketItem) => void) | undefined;
  private closedItem: Extract<ComfySocketItem, { kind: 'closed' }> | undefined;
  private readonly detachAbort: () => void;

  constructor(
    private readonly socket: WebSocket,
    signal: AbortSignal,
  ) {
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.enqueue({ kind: 'binary', bytes: Uint8Array.from(rawDataBuffer(data)) });
        return;
      }
      const raw = rawDataBuffer(data).toString('utf8');
      try {
        this.enqueue({ kind: 'json', value: JSON.parse(raw), raw });
      } catch (cause) {
        this.enqueue({ kind: 'invalid_json', raw, cause });
      }
    };
    const onError = (cause: Error) => this.enqueue({ kind: 'error', cause });
    const onClose = (code: number, reason: Buffer) => {
      const item = { kind: 'closed' as const, code, reason: reason.toString('utf8') };
      this.closedItem = item;
      this.enqueue(item);
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.on('close', onClose);

    const abort = () => this.terminate();
    signal.addEventListener('abort', abort, { once: true });
    this.detachAbort = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  }

  async nextWithin(timeoutMs: number, signal: AbortSignal): Promise<ComfySocketItem | undefined> {
    signal.throwIfAborted();
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.closedItem) return this.closedItem;
    if (this.waiter) throw new Error('Only one ComfyUI WebSocket consumer is allowed');

    return new Promise<ComfySocketItem | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.waiter = undefined;
        operation();
      };
      const timer = setTimeout(() => finish(() => resolve(undefined)), timeoutMs);
      const abort = () => finish(() => reject(abortReason(signal)));
      this.waiter = (item) => finish(() => resolve(item));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  close(): void {
    this.detachAbort();
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'observer complete');
    else if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
  }

  private terminate(): void {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }

  private enqueue(item: ComfySocketItem): void {
    if (this.waiter) {
      const waiter = this.waiter;
      waiter(item);
      return;
    }
    if (this.queue.length >= MAX_QUEUED_MESSAGES) {
      this.queue.length = 0;
      this.queue.push({
        kind: 'error',
        cause: new Error(`ComfyUI WebSocket exceeded ${MAX_QUEUED_MESSAGES} queued messages`),
      });
      this.terminate();
      return;
    }
    this.queue.push(item);
  }
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TypeError('Unsupported WebSocket RawData value');
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('ComfyUI WebSocket observation aborted');
}
