import type { BrowserWindow } from 'electron';
import type { WindowConnection } from '../transport/electron/window-connection.js';
import { EmbeddedBrowserSession } from './embedded-browser-session.js';

export class WindowSession {
  readonly id: number;
  readonly webContentsId: number;
  readonly embeddedBrowser: EmbeddedBrowserSession;

  private readonly connections = new Set<WindowConnection>();
  private readonly usedNonces = new Set<string>();
  private activeConnection?: WindowConnection;
  private reservedNonce?: string;
  private disposed = false;
  private navigationEpoch = 0;

  constructor(readonly window: BrowserWindow) {
    this.id = window.id;
    this.webContentsId = window.webContents.id;
    this.embeddedBrowser = new EmbeddedBrowserSession(window);
    window.webContents.on('did-start-navigation', this.handleNavigation);
    window.webContents.on('render-process-gone', this.handleRendererGone);
  }

  reserveConnection(windowNonce: string): boolean {
    if (this.disposed || this.window.isDestroyed()) return false;
    if (this.activeConnection || this.reservedNonce || this.usedNonces.has(windowNonce)) return false;
    this.reservedNonce = windowNonce;
    this.usedNonces.add(windowNonce);
    return true;
  }

  attachConnection(windowNonce: string, connection: WindowConnection): void {
    if (this.disposed || this.reservedNonce !== windowNonce || this.activeConnection) {
      void connection.close('window-session-rejected');
      return;
    }
    this.reservedNonce = undefined;
    this.activeConnection = connection;
    this.connections.add(connection);
  }

  detachConnection(connection: WindowConnection): void {
    this.connections.delete(connection);
    if (this.activeConnection === connection) this.activeConnection = undefined;
  }

  async dispose(reason: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.reservedNonce = undefined;
    if (!this.window.isDestroyed()) {
      const contents = this.window.webContents;
      contents.removeListener('did-start-navigation', this.handleNavigation);
      contents.removeListener('render-process-gone', this.handleRendererGone);
    }
    this.embeddedBrowser.dispose();
    const connections = [...this.connections];
    this.connections.clear();
    this.activeConnection = undefined;
    await Promise.allSettled(connections.map((connection) => connection.close(reason)));
  }

  snapshot(): {
    id: number;
    webContentsId: number;
    navigationEpoch: number;
    connections: number;
    disposed: boolean;
    embeddedBrowser: ReturnType<EmbeddedBrowserSession['snapshot']>;
  } {
    return Object.freeze({
      id: this.id,
      webContentsId: this.webContentsId,
      navigationEpoch: this.navigationEpoch,
      connections: this.connections.size,
      disposed: this.disposed,
      embeddedBrowser: this.embeddedBrowser.snapshot(),
    });
  }

  private readonly handleNavigation = (
    _event: Electron.Event,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ): void => {
    // Hash/history routing stays in the same document and must retain its port.
    if (!isMainFrame || isInPlace) return;
    this.navigationEpoch += 1;
    this.reservedNonce = undefined;
    const connections = [...this.connections];
    this.connections.clear();
    this.activeConnection = undefined;
    for (const connection of connections) void connection.close('main-frame-navigation');
  };

  private readonly handleRendererGone = (): void => {
    this.navigationEpoch += 1;
    const connections = [...this.connections];
    this.connections.clear();
    this.activeConnection = undefined;
    this.reservedNonce = undefined;
    for (const connection of connections) void connection.close('renderer-gone');
  };
}
