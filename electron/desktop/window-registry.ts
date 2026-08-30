import { appLog } from '@electron/observability/logging/app-log.js';
import { createUuid } from '@shared/utils/identifiers.js';

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  net,
  screen,
  shell,
  type OpenDialogOptions,
  type Protocol,
} from 'electron';
import type { CallerWindowConfig } from '../../shared/types/index.js';
import type { BrowserLaunchWindowSize } from '../piskiepilot/browser/core/browser/browser-launch-spec.js';
import type {
  AuthorizedBootstrap,
  BootstrapRequest,
} from '../transport/electron/bootstrap-listener.js';
import type {
  DesktopPresentationPort,
  EmbeddedBrowserPresentation,
} from './desktop-presentation-port.js';
import { WindowSession } from './window-session.js';
import { THEME_BACKGROUND_HOST } from '../../shared/constants/theme-background.js';
import {
  ATTACHMENT_PREVIEW_HOST,
  ATTACHMENT_PREVIEW_SCHEME,
  themeBackgroundsDir,
} from './attachment-preview-protocol.js';
export interface MainWindowOptions {
  readonly rendererUrl: string;
  readonly preloadPath: string;
  readonly iconPath: string;
  readonly development: boolean;
}

const PANEL_BROWSER_MIN_WIDTH = 1024;
const DEVELOPMENT_RENDERER_RECOVERY_DELAY_MS = 1_500;
const DEVELOPMENT_RENDERER_RECOVERY_LIMIT = 3;
const MAX_FILE_PREVIEWS_PER_WINDOW = 256;

interface FilePreviewEntry {
  readonly windowId: number;
  readonly filePath: string;
  readonly mediaType: string;
}

export class WindowRegistry implements DesktopPresentationPort {
  private readonly sessionsByWindowId = new Map<number, WindowSession>();
  private readonly sessionsByWebContentsId = new Map<number, WindowSession>();
  private readonly auxiliaryWindows = new Set<BrowserWindow>();
  private readonly filePreviews = new Map<string, FilePreviewEntry>();
  private previewProtocol?: Protocol;
  private mainWindowId?: number;
  private stopped = false;
  /** 应用真正退出中:主窗口关闭不再被拦成隐藏 */
  private quitting = false;
  private onConnectionClosed?: (connectionId: string) => void;

  constructor(
    private readonly options: {
      rendererUrl: string;
      rendererBuildId: string;
      platform: NodeJS.Platform;
    }
  ) {}

  setConnectionReleaseHandler(handler: (connectionId: string) => void): void {
    this.onConnectionClosed = handler;
  }

  async createMainWindow(options: MainWindowOptions): Promise<WindowSession> {
    if (this.stopped) throw new Error('Window registry is stopped');
    const existing = this.mainSession();
    if (existing && !existing.window.isDestroyed()) {
      existing.window.show();
      existing.window.focus();
      return existing;
    }

    const window = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      show: false,
      backgroundColor: '#e9f2f7',
      icon: options.iconPath,
      //  天际栏:红绿灯与 48px 单栏同层,显式定位使其垂直居中(12px 钮高 → y=18)
      ...(this.options.platform === 'darwin' && {
        titleBarStyle: 'hidden' as const,
        trafficLightPosition: { x: 18, y: 18 },
      }),
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: options.development,
      },
    });
    window.setMenu(null);
    const session = new WindowSession(window);
    this.sessionsByWindowId.set(window.id, session);
    this.sessionsByWebContentsId.set(window.webContents.id, session);
    this.mainWindowId = window.id;
    this.configureMainWindow(session, options);

    let presented = false;
    const presentWindow = (): void => {
      if (presented || window.isDestroyed()) return;
      presented = true;
      window.show();
      window.focus();
    };
    window.once('ready-to-show', presentWindow);
    /**
     * 关闭按钮 = 退到托盘(微信语义):窗口隐藏、渲染状态保留、后台任务继续。
     * 真正退出(Cmd+Q / 托盘退出 / 停机)置 quitting 后走 destroy,不经过 close 事件。
     */
    window.on('close', (event) => {
      if (this.quitting || this.stopped) return;
      event.preventDefault();
      if (window.isFullScreen()) {
        window.once('leave-full-screen', () => {
          if (!window.isDestroyed()) window.hide();
        });
        window.setFullScreen(false);
        return;
      }
      window.hide();
    });
    window.once('closed', () => {
      void this.releaseWindow(session, 'window-closed');
    });
    await window.loadURL(options.rendererUrl);
    // Some Linux compositor/Electron combinations do not emit ready-to-show.
    presentWindow();
    return session;
  }

  authorize(request: BootstrapRequest): AuthorizedBootstrap | undefined {
    if (this.stopped || !request.isMainFrame) return undefined;
    if (request.hello.rendererBuildId !== this.options.rendererBuildId) return undefined;
    if (!this.isAllowedRendererUrl(request.frameUrl)) return undefined;
    const session = this.sessionsByWebContentsId.get(request.senderId);
    if (!session || !session.reserveConnection(request.hello.windowNonce)) return undefined;
    return {
      windowId: session.id,
      attach: (connection) => session.attachConnection(request.hello.windowNonce, connection),
      detached: (connection) => {
        session.detachConnection(connection);
        this.onConnectionClosed?.(connection.id);
      },
    };
  }

  mainSession(): WindowSession | undefined {
    return this.mainWindowId === undefined
      ? undefined
      : this.sessionsByWindowId.get(this.mainWindowId);
  }

  pilotCallerWindow(): CallerWindowConfig {
    if (this.options.platform === 'darwin') {
      return { bundleId: app.isPackaged ? 'dev.piskie.desktop' : 'com.github.Electron' };
    }
    const window = this.mainSession()?.window;
    if (!window || window.isDestroyed()) return {};
    try {
      const handle = window.getNativeWindowHandle();
      if (this.options.platform === 'win32') return { hwnd: handle.readInt32LE(0) };
      if (this.options.platform === 'linux') {
        return { windowId: `0x${handle.readUInt32LE(0).toString(16)}` };
      }
    } catch (error) {
      appLog.warn({
        event: 'desktop.caller_window.resolve.degraded',
        message: 'Desktop caller window resolution degraded',
        context: { scope: 'desktop.caller_window', windowId: window.id },
        error: error,
      });
    }
    return {};
  }

  pilotBrowserWindowSize(): BrowserLaunchWindowSize | undefined {
    if (this.stopped) return undefined;
    try {
      const window = this.mainSession()?.window;
      const display =
        window && !window.isDestroyed()
          ? screen.getDisplayMatching(window.getBounds())
          : screen.getPrimaryDisplay();
      const { width, height } = display.workAreaSize;
      if (width < PANEL_BROWSER_MIN_WIDTH || height <= 0) return undefined;
      return Object.freeze({ width: PANEL_BROWSER_MIN_WIDTH, height });
    } catch (error) {
      appLog.warn({
        event: 'desktop.browser_bounds.resolve.degraded',
        message: 'Desktop browser bounds resolution degraded',
        context: { scope: 'desktop.browser_bounds' },
        error: error,
      });
      return undefined;
    }
  }

  embeddedBrowser(windowId: number): EmbeddedBrowserPresentation {
    return this.requireSession(windowId).embeddedBrowser;
  }

  openDevTools(windowId: number): void {
    this.requireSession(windowId).window.webContents.openDevTools({ mode: 'detach' });
  }

  setMainWindowIcon(iconPath: string): void {
    if (this.options.platform === 'darwin') return;
    const window = this.mainSession()?.window;
    if (window && !window.isDestroyed()) window.setIcon(iconPath);
  }

  async chooseFiles(
    windowId: number,
    request: { type: 'file' | 'folder' | 'any' }
  ): Promise<string[]> {
    const session = this.requireSession(windowId);
    const options: OpenDialogOptions =
      request.type === 'folder'
        ? { title: 'Choose folder', properties: ['openDirectory'] }
        : request.type === 'file'
          ? {
              title: 'Choose documents',
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: 'Documents', extensions: ['txt', 'md'] }],
            }
          : { title: 'Choose files', properties: ['openFile', 'multiSelections'] };
    const result = await dialog.showOpenDialog(session.window, options);
    return result.canceled ? [] : result.filePaths;
  }

  async chooseBackgroundImage(windowId: number): Promise<string | undefined> {
    const session = this.requireSession(windowId);
    const result = await dialog.showOpenDialog(session.window, {
      title: 'Choose background image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    return result.canceled ? undefined : result.filePaths[0];
  }

  createFilePreviewUrl(windowId: number, filePath: string, mediaType: string): string {
    this.requireSession(windowId);
    const ownedTokens = [...this.filePreviews]
      .filter(([, entry]) => entry.windowId === windowId)
      .map(([token]) => token);
    for (const token of ownedTokens.slice(
      0,
      ownedTokens.length - MAX_FILE_PREVIEWS_PER_WINDOW + 1
    )) {
      this.filePreviews.delete(token);
    }

    const token = createUuid();
    this.filePreviews.set(token, { windowId, filePath, mediaType });
    return `${ATTACHMENT_PREVIEW_SCHEME}://${ATTACHMENT_PREVIEW_HOST}/${token}`;
  }

  async chooseSavePath(
    windowId: number,
    request: { title: string; suggestedName: string; extensions: readonly string[] }
  ): Promise<string | undefined> {
    const session = this.requireSession(windowId);
    const result = await dialog.showSaveDialog(session.window, {
      title: request.title,
      defaultPath: path.basename(request.suggestedName),
      filters: [{ name: 'File', extensions: [...request.extensions] }],
    });
    return result.canceled ? undefined : result.filePath;
  }

  async openAuthorization(url: string, onClosed?: () => void): Promise<() => void> {
    const target = safeHttpUrl(url);
    if (!target) throw new Error('Authorization URL is not allowed');
    const parent = this.mainSession()?.window;
    const window = new BrowserWindow({
      width: 920,
      height: 760,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      title: 'Piskie - Authorization',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    this.auxiliaryWindows.add(window);
    let closedByOwner = false;
    window.webContents.setWindowOpenHandler(({ url: external }) => {
      const safe = safeHttpUrl(external);
      if (safe) void shell.openExternal(safe);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, next) => {
      if (!safeHttpUrl(next)) event.preventDefault();
    });
    window.once('closed', () => {
      this.auxiliaryWindows.delete(window);
      if (!closedByOwner) onClosed?.();
    });
    try {
      await window.loadURL(target);
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
    return () => {
      closedByOwner = true;
      if (!window.isDestroyed()) window.close();
    };
  }

  /** 由 DesktopRuntime 在真正退出前调用,解除主窗口的隐藏拦截 */
  markQuitting(): void {
    this.quitting = true;
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const sessions = [...this.sessionsByWindowId.values()];
    this.sessionsByWindowId.clear();
    this.sessionsByWebContentsId.clear();
    this.filePreviews.clear();
    this.mainWindowId = undefined;
    const failures: unknown[] = [];
    if (this.previewProtocol) {
      try {
        this.previewProtocol.unhandle(ATTACHMENT_PREVIEW_SCHEME);
      } catch (error) {
        failures.push(error);
      }
      this.previewProtocol = undefined;
    }
    const results = await Promise.allSettled(
      sessions.map(async (session) => {
        try {
          await session.dispose(reason);
        } finally {
          if (!session.window.isDestroyed()) session.window.destroy();
        }
      })
    );
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    for (const window of [...this.auxiliaryWindows]) {
      try {
        if (!window.isDestroyed()) window.destroy();
      } catch (error) {
        failures.push(error);
      }
    }
    this.auxiliaryWindows.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more desktop windows failed to close');
    }
  }

  snapshot(): {
    stopped: boolean;
    windows: readonly ReturnType<WindowSession['snapshot']>[];
    auxiliaryWindows: number;
  } {
    return Object.freeze({
      stopped: this.stopped,
      windows: Object.freeze(
        [...this.sessionsByWindowId.values()].map((session) => session.snapshot())
      ),
      auxiliaryWindows: this.auxiliaryWindows.size,
    });
  }

  private configureMainWindow(session: WindowSession, options: MainWindowOptions): void {
    const { window } = session;
    this.installAttachmentPreviewHandler(window.webContents.session.protocol);
    /**
     * 权限白名单:默认全拒,仅放行剪贴板写入——
     * navigator.clipboard.writeText 走 `clipboard-sanitized-write` 权限,
     * 全拒会让渲染层所有"复制"按钮静默失败(2026-08-25 审阅面板复制暴露的存量坑)。
     * 本地渲染进程与主进程同属一个用户信任域,写剪贴板无跨域风险。
     */
    const allowPermission = (permission: string): boolean => permission === 'clipboard-sanitized-write';
    window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(allowPermission(permission));
    });
    window.webContents.session.setPermissionCheckHandler(
      (_contents, permission) => allowPermission(permission),
    );
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, nextUrl) => {
      if (!this.isAllowedRendererUrl(nextUrl)) event.preventDefault();
    });
    window.webContents.on('before-input-event', (event, input) => {
      const modifier = this.options.platform === 'darwin' ? input.meta : input.control;
      if (modifier && ['r', 'f', 'g', 'p'].includes(input.key.toLowerCase()))
        event.preventDefault();
      if (!options.development && input.key === 'F12') event.preventDefault();
      if (!options.development && modifier && input.shift && input.key.toLowerCase() === 'i') {
        event.preventDefault();
      }
    });
    window.webContents.on('did-fail-load', (_event, code, description, _url) => {
      if (options.development || code === -3) return;
      appLog.error({
        event: 'desktop.renderer.load.failed',
        message: 'Desktop renderer load failed',
        context: {
          scope: 'desktop.renderer',
          code: code,
          description: description,
          windowId: window.id,
        },
      });
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      this.releaseFilePreviews(window.id);
      appLog.error({
        event: 'desktop.renderer.process.failed',
        message: 'Desktop renderer process failed',
        context: {
          scope: 'desktop.renderer',
          windowId: window.id,
          reason: details.reason,
          exitCode: details.exitCode,
        },
      });
    });
    window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.releaseFilePreviews(window.id);
    });
    if (options.development) this.installDevelopmentRendererRecovery(session);
  }

  private installDevelopmentRendererRecovery(session: WindowSession): void {
    const { window } = session;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleCheck = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (window.isDestroyed()) return;
        const contents = window.webContents;
        void contents
          .executeJavaScript(
            `
          (() => {
            const root = document.getElementById('root');
            return document.readyState === 'complete' && root !== null && root.childElementCount === 0;
          })()
        `
          )
          .then((blank: boolean) => {
            if (window.isDestroyed()) return;
            if (!blank) {
              attempts = 0;
              return;
            }
            if (attempts >= DEVELOPMENT_RENDERER_RECOVERY_LIMIT) {
              appLog.error({
                event: 'desktop.renderer.recover.failed',
                message: 'Desktop renderer recovery failed',
                context: {
                  scope: 'desktop.renderer',
                  retryCount: attempts,
                  windowId: window.id,
                },
              });
              return;
            }
            attempts += 1;
            contents.reload();
          })
          .catch((error) => {
            appLog.warn({
              event: 'desktop.renderer.health_check.degraded',
              message: 'Desktop renderer health check degraded',
              context: { scope: 'desktop.renderer', windowId: window.id },
              error: error,
            });
          });
      }, DEVELOPMENT_RENDERER_RECOVERY_DELAY_MS);
    };

    window.webContents.on('did-finish-load', scheduleCheck);
    window.once('closed', () => {
      if (timer) clearTimeout(timer);
    });
  }

  private async releaseWindow(session: WindowSession, reason: string): Promise<void> {
    this.sessionsByWindowId.delete(session.id);
    this.sessionsByWebContentsId.delete(session.webContentsId);
    this.releaseFilePreviews(session.id);
    if (this.mainWindowId === session.id) this.mainWindowId = undefined;
    await session.dispose(reason).catch((error) => {
      appLog.warn({
        event: 'desktop.window.release.degraded',
        message: 'Desktop window release degraded',
        context: { scope: 'desktop.window', windowId: session.id, reason: reason },
        error: error,
      });
    });
  }

  private requireSession(windowId: number): WindowSession {
    const session = this.sessionsByWindowId.get(windowId);
    if (!session || session.window.isDestroyed()) throw new Error('Window session is unavailable');
    return session;
  }

  private releaseFilePreviews(windowId: number): void {
    for (const [token, entry] of this.filePreviews) {
      if (entry.windowId === windowId) this.filePreviews.delete(token);
    }
  }

  private installAttachmentPreviewHandler(target: Protocol): void {
    if (this.previewProtocol) return;
    target.handle(ATTACHMENT_PREVIEW_SCHEME, (request) => this.serveFilePreview(request));
    this.previewProtocol = target;
  }

  private async serveFilePreview(request: Request): Promise<Response> {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers });
    }

    let entry: FilePreviewEntry | undefined;
    try {
      const target = new URL(request.url);
      if (target.protocol === `${ATTACHMENT_PREVIEW_SCHEME}:`) {
        // 主题壁纸 host:静态文件位,不走按窗口 token(壁纸 URL 需跨启动稳定)
        if (target.hostname === THEME_BACKGROUND_HOST) {
          return await this.serveThemeBackground(request, target, headers);
        }
        if (target.hostname === ATTACHMENT_PREVIEW_HOST) {
          entry = this.filePreviews.get(target.pathname.slice(1));
        }
      }
    } catch {
      // Invalid preview URLs are indistinguishable from expired tokens.
    }
    if (!entry || !this.sessionsByWindowId.has(entry.windowId)) {
      return new Response(null, { status: 404, headers });
    }

    try {
      const source = await net.fetch(pathToFileURL(entry.filePath).toString(), {
        method: request.method,
        headers: request.headers.has('range')
          ? { Range: request.headers.get('range') ?? '' }
          : undefined,
      });
      if (!source.ok) return new Response(null, { status: 404, headers });
      const responseHeaders = new Headers(source.headers);
      for (const [name, value] of Object.entries(headers)) responseHeaders.set(name, value);
      responseHeaders.set('Content-Type', entry.mediaType);
      responseHeaders.delete('Content-Disposition');
      return new Response(request.method === 'HEAD' ? null : source.body, {
        status: source.status,
        statusText: source.statusText,
        headers: responseHeaders,
      });
    } catch {
      return new Response(null, { status: 404, headers });
    }
  }

  /**
   * 主题壁纸:只服务 {userData}/themes/ 下 `background-*` 的落盘文件。
   * 文件名带时间戳(theme.service 每次导入换名),可给长缓存。
   */
  private async serveThemeBackground(
    request: Request,
    target: URL,
    headers: Record<string, string>,
  ): Promise<Response> {
    const fileName = decodeURIComponent(target.pathname.slice(1));
    const safe =
      fileName.startsWith('background-') &&
      !fileName.includes('/') &&
      !fileName.includes('\\') &&
      !fileName.includes('..');
    if (!safe) return new Response(null, { status: 404, headers });

    const mediaTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.avif': 'image/avif',
      '.bmp': 'image/bmp',
    };
    const mediaType = mediaTypes[path.extname(fileName).toLowerCase()];
    if (!mediaType) return new Response(null, { status: 404, headers });

    try {
      const filePath = path.join(themeBackgroundsDir(), fileName);
      const source = await net.fetch(pathToFileURL(filePath).toString(), {
        method: request.method,
      });
      if (!source.ok) return new Response(null, { status: 404, headers });
      const responseHeaders = new Headers(source.headers);
      for (const [name, value] of Object.entries(headers)) responseHeaders.set(name, value);
      responseHeaders.set('Content-Type', mediaType);
      responseHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
      responseHeaders.delete('Content-Disposition');
      return new Response(request.method === 'HEAD' ? null : source.body, {
        status: source.status,
        statusText: source.statusText,
        headers: responseHeaders,
      });
    } catch {
      return new Response(null, { status: 404, headers });
    }
  }

  private isAllowedRendererUrl(candidate: string): boolean {
    try {
      const expected = new URL(this.options.rendererUrl);
      const actual = new URL(candidate);
      if (expected.protocol !== actual.protocol) return false;
      if (expected.protocol === 'file:') return expected.pathname === actual.pathname;
      return expected.origin === actual.origin && expected.pathname === actual.pathname;
    } catch {
      return false;
    }
  }
}

function safeHttpUrl(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (url.username || url.password) return undefined;
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
