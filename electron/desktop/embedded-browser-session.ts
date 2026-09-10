import { appLog } from '@electron/observability/logging/app-log.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, WebContentsView, session } from 'electron';
import { createChangeChannel, type ChangeSource } from '../core/change-channel.js';
import { EMPTY_EMBEDDED_BROWSER_STATE, type EmbeddedBrowserState } from '../../shared/types/embedded-browser.js';
import type { EmbeddedBrowserPage } from './desktop-presentation-port.js';
const PARTITION = 'persist:piskie-embedded-browser';

export class EmbeddedBrowserSession implements EmbeddedBrowserPage {
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

  constructor(private readonly window: BrowserWindow) {}

  open(): void {
    this.ensureView();
  }

  state(): EmbeddedBrowserState {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return EMPTY_EMBEDDED_BROWSER_STATE;
    return {
      open: true,
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
    if (this.disposed) return true;
    const contents = this.ensureView().webContents;
    if (contents.getURL() !== target) await this.load(() => contents.loadURL(target));
    return true;
  }

  async openLocalHtml(filePath: string): Promise<void> {
    if (this.disposed) return;
    const contents = this.ensureView().webContents;
    if (contents.getURL() !== pathToFileURL(filePath).href) {
      await this.load(() => contents.loadFile(filePath));
    }
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
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
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
      if (this.view && this.visible) this.window.contentView.removeChildView(this.view);
    } catch {
      // The owner window may already be destroyed.
    }
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.close({ waitForBeforeUnload: false });
    }
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

  private async load(navigate: () => Promise<void>): Promise<void> {
    try {
      await navigate();
    } catch (error) {
      // Closing a page or starting another navigation cancels an in-flight load.
      if (this.disposed || (error as { code?: string }).code === 'ERR_ABORTED') return;
      throw error;
    }
  }

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
  if (/^(https?):/i.test(value)) return isAllowedEmbeddedUrl(value) ? new URL(value).href : undefined;
  if (/^about:blank$/i.test(value)) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  const scheme = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(value) ? 'http' : 'https';
  const target = `${scheme}://${value}`;
  return isAllowedEmbeddedUrl(target) ? new URL(target).href : undefined;
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
