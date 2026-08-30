import { MessageChannelMain, type MessagePortMain } from 'electron';
import { screenStreamHub, type ViewerSink } from '../piskiepilot/browser/screen-hub.js';
import type {
  BrowserStreamRequest,
  ScreenStreamRequest,
  StreamControlMessage,
  StreamServerMessage,
} from '../../shared/types/stream.js';
interface StreamLease {
  readonly id: string;
  readonly kind: 'browser';
  readonly targetId: string;
  close(): void;
}

class BrowserPortSink implements ViewerSink {
  private open = true;
  private frameInFlight = false;
  private pendingFrame: StreamServerMessage | null = null;

  constructor(private readonly port: MessagePortMain) {}

  send(message: StreamServerMessage): void {
    if (!this.open) return;
    if (message.type !== 'frame') {
      this.post(message);
      return;
    }
    if (this.frameInFlight) {
      this.pendingFrame = message;
      return;
    }
    this.frameInFlight = true;
    this.post(message);
  }

  acknowledgeFrame(): void {
    if (!this.pendingFrame) {
      this.frameInFlight = false;
      return;
    }
    const next = this.pendingFrame;
    this.pendingFrame = null;
    this.post(next);
  }

  isOpen(): boolean {
    return this.open;
  }

  close(): void {
    this.open = false;
    this.pendingFrame = null;
  }

  private post(message: StreamServerMessage): void {
    try {
      this.port.postMessage(message);
    } catch {
      this.close();
    }
  }
}

export class ScreenStreamService {
  private readonly leases = new Map<string, StreamLease>();
  private accepting = false;

  start(): void {
    if (this.accepting) return;
    this.accepting = true;
  }

  open(request: ScreenStreamRequest): Promise<MessagePortMain> {
    if (!this.accepting) throw new Error('Screen streaming is not available');
    if (this.leases.has(request.requestId)) {
      throw new Error(`Screen stream request already exists: ${request.requestId}`);
    }
    return this.openBrowser(request);
  }

  stop(): void {
    this.accepting = false;
    for (const lease of [...this.leases.values()]) lease.close();
  }

  lifecycleSnapshot(): {
    accepting: boolean;
    activeStreams: readonly { id: string; kind: 'browser'; targetId: string }[];
  } {
    return Object.freeze({
      accepting: this.accepting,
      activeStreams: Object.freeze(
        [...this.leases.values()].map((lease) =>
          Object.freeze({
            id: lease.id,
            kind: lease.kind,
            targetId: lease.targetId,
          })
        )
      ),
    });
  }

  private async openBrowser(request: BrowserStreamRequest): Promise<MessagePortMain> {
    const { port1, port2 } = new MessageChannelMain();
    const sink = new BrowserPortSink(port1);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      this.leases.delete(request.requestId);
      sink.close();
      screenStreamHub.removeViewer(request.browserId, sink);
      port1.close();
    };
    const lease: StreamLease = {
      id: request.requestId,
      kind: 'browser',
      targetId: request.browserId,
      close,
    };
    this.leases.set(request.requestId, lease);

    port1.on('message', (event) => {
      const message = event.data as StreamControlMessage;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ack') sink.acknowledgeFrame();
      if (message.type === 'set-fps') {
        void screenStreamHub.updateViewerFps(request.browserId, sink, message.fps);
      }
      if (message.type === 'input') {
        void screenStreamHub.dispatchInput(request.browserId, message.event).catch(() => undefined);
      }
      if (message.type === 'set-quality') {
        void screenStreamHub.updateViewerQuality(request.browserId, sink, {
          quality: message.quality,
          maxWidth: message.maxWidth,
          maxHeight: message.maxHeight,
        });
      }
      if (message.type === 'stop') close();
    });
    port1.on('close', close);
    port1.start();

    try {
      await screenStreamHub.addViewer(request.browserId, sink, {
        fps: request.fps,
        quality: request.quality,
        maxWidth: request.maxWidth,
        maxHeight: request.maxHeight,
      });

      return port2;
    } catch (error) {
      close();
      port2.close();
      throw error;
    }
  }
}

export const screenStreamService = new ScreenStreamService();
