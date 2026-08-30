import {
  ipcMain,
  type IpcMainEvent,
  type MessagePortMain,
} from 'electron';
import {
  ELECTRON_CONNECT_CHANNEL,
  type BackendRuntimeSnapshot,
  type ConnectHello,
} from '../../../shared/electron-contracts/protocol.js';
import type { TransferPort } from '../../capabilities/catalog.js';
import { decodeConnectHello } from './protocol-codec.js';
import { WindowConnection, type HostMessagePort } from './window-connection.js';
import { PortRouter } from './port-router.js';

export interface BootstrapRequest {
  readonly senderId: number;
  readonly frameUrl: string;
  readonly isMainFrame: boolean;
  readonly hello: ConnectHello;
}

export interface AuthorizedBootstrap {
  readonly windowId: number;
  attach(connection: WindowConnection): void;
  detached?(connection: WindowConnection): void;
}

export interface ElectronPortServerOptions {
  readonly generation: string;
  readonly router: PortRouter;
  readonly runtimeSnapshot: () => BackendRuntimeSnapshot;
  authorize(request: BootstrapRequest): AuthorizedBootstrap | undefined;
}

export class ElectronPortServer {
  private readonly connections = new Set<WindowConnection>();
  private listening = false;

  constructor(private readonly options: ElectronPortServerOptions) {}

  start(): void {
    if (this.listening) throw new Error('Electron port server is already listening');
    ipcMain.on(ELECTRON_CONNECT_CHANNEL, this.handleConnect);
    this.listening = true;
  }

  async stop(reason = 'desktop-stop'): Promise<void> {
    if (this.listening) {
      ipcMain.removeListener(ELECTRON_CONNECT_CHANNEL, this.handleConnect);
      this.listening = false;
    }
    const connections = [...this.connections];
    this.connections.clear();
    await Promise.allSettled(connections.map((connection) => connection.close(reason)));
  }

  snapshot(): { listening: boolean; connectionCount: number } {
    return Object.freeze({
      listening: this.listening,
      connectionCount: this.connections.size,
    });
  }

  private readonly handleConnect = (event: IpcMainEvent, rawHello: unknown): void => {
    const rawPort = event.ports[0];
    if (!rawPort || event.ports.length !== 1) {
      for (const extraPort of event.ports) extraPort.close();
      return;
    }
    const port = new ElectronHostMessagePort(rawPort);

    try {
      const hello = decodeConnectHello(rawHello);
      const senderFrame = event.senderFrame;
      const mainFrame = event.sender.mainFrame;
      const isMainFrame = Boolean(senderFrame && mainFrame && senderFrame === mainFrame);
      const authorized = this.options.authorize({
        senderId: event.sender.id,
        frameUrl: senderFrame?.url ?? '',
        isMainFrame,
        hello,
      });
      if (!authorized) {
        port.postMessage({ kind: 'closed', reason: 'connection-rejected' });
        port.close();
        return;
      }

      const connection = new WindowConnection(port, this.options.router, {
        generation: this.options.generation,
        windowId: authorized.windowId,
        welcome: {
          protocolVersion: 1,
          generation: this.options.generation,
          runtime: this.options.runtimeSnapshot(),
          capabilities: this.options.router.capabilities(),
        },
        onClosed: (closed) => {
          this.connections.delete(closed);
          authorized.detached?.(closed);
        },
      });
      authorized.attach(connection);
      this.connections.add(connection);
      connection.start();
    } catch {
      port.postMessage({ kind: 'closed', reason: 'invalid-handshake' });
      port.close();
    }
  };
}

class ElectronHostMessagePort implements HostMessagePort {
  constructor(private readonly port: MessagePortMain) {}

  postMessage(message: unknown, transfer: readonly TransferPort[] = []): void {
    this.port.postMessage(message, transfer as MessagePortMain[]);
  }

  on(event: 'message', listener: (event: { data: unknown }) => void): this;
  on(event: 'close', listener: () => void): this;
  on(
    event: 'message' | 'close',
    listener: ((event: { data: unknown }) => void) | (() => void),
  ): this {
    if (event === 'message') {
      this.port.on('message', listener as (event: Electron.MessageEvent) => void);
    } else {
      this.port.on('close', listener as () => void);
    }
    return this;
  }

  start(): void {
    this.port.start();
  }

  close(): void {
    this.port.close();
  }
}
