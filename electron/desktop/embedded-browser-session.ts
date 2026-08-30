import { appLog } from '@electron/observability/logging/app-log.js';
import path from 'node:path';
import { BrowserWindow, WebContentsView, session } from 'electron';
import { createChangeChannel, type ChangeSource } from '../core/change-channel.js';
import type { EmbeddedBrowserState } from '../../shared/types/embedded-browser.js';
import type { EmbeddedBrowserPresentation } from './desktop-presentation-port.js';
const PARTITION = 'persist:piskie-embedded-browser';
const EMPTY_STATE: EmbeddedBrowserState = Object.freeze({
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
});

export class EmbeddedBrowserSession implements EmbeddedBrowserPresentation {
  private readonly changeChannel = createChangeChannel<EmbeddedBrowserState>({
    onSubscriberError: (error) =>
      appLog.error({
        event: 'browser.view_state.publish.failed',
        message: 'Embedded browser state publication failed',
        context: { scope: 'browser.view_state' },
        error,
      }),
  });
  private view?: WebContentsView;
  private visible = false;
  private disposed = false;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };

  readonly changes: ChangeSource<EmbeddedBrowserState> = this.changeChannel.source;

  constructor(private readonly window: BrowserWindow) {
    window.webContents.on('did-start-navigation', this.hideForHostNavigation);
  }

  state(): EmbeddedBrowserState {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return EMPTY_STATE;
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    };
  }

  async navigate(address: string): Promise<boolean> {
    const target = normalizeEmbeddedAddress(address);
    if (!target) return false;
    await this.ensureView().webContents.loadURL(target);
    return true;
  }

  async openLocalHtml(filePath: string): Promise<void> {
    await this.ensureView().webContents.loadFile(filePath);
  }

  back(): void {
    const history = this.view?.webContents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
  }

  forward(): void {
    const history = this.view?.webContents.navigationHistory;
    if (history?.canGoForward()) history.goForward();
  }

  reload(): void {
    this.view?.webContents.reload();
  }

  stop(): void {
    this.view?.webContents.stop();
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    };
    if (this.visible) this.view?.setBounds(this.bounds);
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.window.isDestroyed()) return;
    if (!visible && !this.view) return;
    const view = this.ensureView();
    if (visible === this.visible) return;
    if (visible) {
      this.window.contentView.addChildView(view);
      view.setBounds(this.bounds);
    } else {
      this.window.contentView.removeChildView(view);
    }
    this.visible = visible;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.window.webContents.removeListener('did-start-navigation', this.hideForHostNavigation);
      if (this.view && this.visible) this.window.contentView.removeChildView(this.view);
    } catch {
      // The owner window may already be destroyed.
    }
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = undefined;
    this.visible = false;
  }

  snapshot(): { disposed: boolean; hasView: boolean; visible: boolean } {
    return Object.freeze({
      disposed: this.disposed,
      hasView: Boolean(this.view && !this.view.webContents.isDestroyed()),
      visible: this.visible,
    });
  }

  private readonly hideForHostNavigation = (): void => {
    this.setVisible(false);
  };

  private ensureView(): WebContentsView {
    if (this.disposed) throw new Error('Embedded browser session is closed');
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;

    const browserSession = session.fromPartition(PARTITION);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false)
    );
    browserSession.setPermissionCheckHandler(() => false);
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedEmbeddedNavigation(url)) void contents.loadURL(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedEmbeddedNavigation(url)) event.preventDefault();
    });
    const publish = (): void => this.changeChannel.sink.publish(this.state());
    contents.on('did-start-loading', publish);
    contents.on('did-stop-loading', publish);
    contents.on('did-navigate', publish);
    contents.on('did-navigate-in-page', publish);
    contents.on('page-title-updated', publish);
    contents.on('render-process-gone', publish);
    this.view = view;

    return view;
  }
}

function normalizeEmbeddedAddress(input: string): string | undefined {
  const value = input.trim();
  if (!value) return undefined;
  if (/^(https?):/i.test(value)) return isAllowedEmbeddedUrl(value) ? value : undefined;
  if (/^about:blank$/i.test(value)) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  const scheme = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(value) ? 'http' : 'https';
  const target = `${scheme}://${value}`;
  return isAllowedEmbeddedUrl(target) ? target : undefined;
}

function isAllowedEmbeddedUrl(input: string): boolean {
  if (input === 'about:blank') return true;
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAllowedEmbeddedNavigation(input: string): boolean {
  if (isAllowedEmbeddedUrl(input)) return true;
  try {
    const url = new URL(input);
    return url.protocol === 'file:'
      && ['.html', '.htm'].includes(path.extname(url.pathname).toLowerCase());
  } catch {
    return false;
  }
}
