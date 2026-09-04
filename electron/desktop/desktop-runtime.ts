import { app, dialog } from 'electron';
import type { BackendComposition } from '../runtime/backend-composition.js';
import { ShutdownCoordinator } from '../runtime/lifecycle/shutdown-coordinator.js';
import type { ShutdownReport } from '../runtime/lifecycle/runtime-state.js';
import {
  createApplicationComposition,
  type ApplicationComposition,
} from '../capabilities/application-composition.js';
import { backendRuntimeSnapshot } from '../capabilities/runtime/runtime-controller.js';
import { PortRouter } from '../transport/electron/port-router.js';
import { ElectronPortServer } from '../transport/electron/bootstrap-listener.js';
import {
  startLocalConfigServer,
  type LocalConfigServer,
} from '../config/host/local-transport.js';
import { createLocalConfigEndpointAdapter } from '../transport/local/config-host-endpoint.js';
import { WindowRegistry, type MainWindowOptions } from './window-registry.js';
import { DesktopTray } from './desktop-tray.js';
import { appLog, closeAppLog } from '../observability/logging/app-log.js';
import type { DesktopColorScheme } from '../../shared/electron-contracts/desktop.js';
import type { DesktopAppearancePort } from './desktop-presentation-port.js';
import type { UpdateDisabledReason } from '../../shared/electron-contracts/updates.js';
import type { UpdateProvider } from '../updates/update-provider.js';

const log = appLog.child({ scope: 'desktop.runtime' });

export interface DesktopShutdownResult {
  readonly exitCode: number;
  readonly backend?: ShutdownReport;
}

export class DesktopRuntime implements DesktopAppearancePort {
  private readonly shutdown = new ShutdownCoordinator<DesktopShutdownResult>();
  private portServer?: ElectronPortServer;
  private configServer?: LocalConfigServer;
  private tray?: DesktopTray;
  private application?: ApplicationComposition;
  private ready = false;
  private quitting = false;
  private runPromise?: Promise<void>;
  private colorScheme: DesktopColorScheme = 'dark';

  constructor(
    private readonly options: {
      backend: BackendComposition;
      windows: WindowRegistry;
      mainWindow: Omit<MainWindowOptions, 'iconPath'>;
      appInfo: {
        accountBaseUrl: string;
        name: string;
        version: string;
        development: boolean;
      };
      updates?: {
        disabledReason?: UpdateDisabledReason;
        createProvider?: () => UpdateProvider;
      };
      platform?: NodeJS.Platform;
      icons: {
        light: string;
        dark: string;
        /** Multi-resolution, high-contrast icon for Windows taskbar surfaces. */
        windows: string;
        /** 缺省时不创建托盘。 */
        trayGlyphs?: {
          light: string;
          dark: string;
        };
      };
    }
  ) {}

  run(): Promise<void> {
    this.runPromise ??= this.runNow();
    return this.runPromise;
  }

  requestQuit(reason: string): Promise<DesktopShutdownResult> {
    this.quitting = true;
    this.ready = false;
    // 解除主窗口的隐藏拦截:真正退出时窗口要能关掉
    this.options.windows.markQuitting();
    return this.shutdown.request(reason, (firstReason) => this.stopNow(firstReason));
  }

  setColorScheme(colorScheme: DesktopColorScheme): void {
    this.colorScheme = colorScheme;
    const iconPath = this.currentIconPath();
    this.options.windows.setMainWindowIcon(iconPath);
    if ((this.options.platform ?? process.platform) === 'darwin') {
      app.dock?.setIcon(iconPath);
    }
  }

  snapshot(): {
    ready: boolean;
    quitting: boolean;
    backend: ReturnType<BackendComposition['runtime']['snapshot']>;
    transport?: ReturnType<ElectronPortServer['snapshot']>;
    windows: ReturnType<WindowRegistry['snapshot']>;
  } {
    return Object.freeze({
      ready: this.ready,
      quitting: this.quitting,
      backend: this.options.backend.runtime.snapshot(),
      transport: this.portServer?.snapshot(),
      windows: this.options.windows.snapshot(),
    });
  }

  private async runNow(): Promise<void> {
    this.installProcessDiagnostics();
    this.installAppLifecycle();
    try {
      await app.whenReady();
      if (this.quitting) return;
      const report = await this.options.backend.runtime.start();
      if (this.quitting) return;
      const capabilities = this.options.backend.runtime.capabilities();
      const updateRuntime = this.createUpdateRuntime();
      const application = createApplicationComposition({
        backend: this.options.backend.runtime,
        capabilities,
        presentation: this.options.windows,
        appearance: this,
        app: {
          ...this.options.appInfo,
          ...updateRuntime,
        },
      });
      this.application = application;
      this.options.windows.setConnectionReleaseHandler(application.releaseConnection);
      const router = new PortRouter(application.catalog, {
        phase: () => {
          const phase = this.options.backend.runtime.snapshot().phase;
          if (phase === 'ready') return 'ready';
          if (phase === 'stopping') return 'stopping';
          return 'closed';
        },
      });
      this.portServer = new ElectronPortServer({
        generation: report.generation,
        router,
        runtimeSnapshot: () => backendRuntimeSnapshot(this.options.backend.runtime.snapshot()),
        authorize: (request) => this.options.windows.authorize(request),
      });
      this.portServer.start();
      const configServer = await startLocalConfigServer({
        rootDirectory: capabilities.userDataDirectory,
        generation: report.generation,
        endpointAdapter: createLocalConfigEndpointAdapter(
          this.options.platform ?? process.platform,
        ),
        host: capabilities.inference.inferenceHost.configHost,
      });
      this.configServer = configServer;
      if (this.quitting) {
        await configServer.stop();
        if (this.configServer === configServer) this.configServer = undefined;
        return;
      }
      if (this.options.icons.trayGlyphs) {
        this.tray = new DesktopTray({
          platform: this.options.platform ?? process.platform,
          lightGlyphPath: this.options.icons.trayGlyphs.light,
          darkGlyphPath: this.options.icons.trayGlyphs.dark,
          observations: capabilities.agent.observations,
          onSummon: () => this.summonMainWindow(),
          onQuit: () => void this.requestQuit('tray-quit'),
        });
        this.tray.start();
      }
      await this.options.windows.createMainWindow(this.mainWindowOptions());
      if (this.quitting) return;
      this.ready = true;
      log.info({
        event: 'desktop.runtime.start.completed',
        message: 'Desktop runtime started',
        context: {
          generation: report.generation,
          degradedCapabilityIds: report.degradedCapabilities.map((item) => item.componentId),
        },
      });
    } catch (error) {
      log.error({
        event: 'desktop.runtime.start.failed',
        message: 'Desktop runtime startup failed',
        error,
      });
      if (!this.quitting) {
        const message = error instanceof Error ? error.message : String(error);
        dialog.showErrorBox(
          'Service startup failed',
          `PISKIE could not start its backend.\n\n${message}`
        );
      }
      await this.requestQuit('desktop-startup-failed');
    }
  }

  /** 呼起主窗口:隐藏/最小化的直接亮出来,销毁过的重建(Dock/托盘/activate 共用) */
  private summonMainWindow(): void {
    if (!this.ready || this.quitting) return;
    const existing = this.options.windows.mainSession();
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.show();
      existing.window.focus();
      return;
    }
    void this.options.windows.createMainWindow(this.mainWindowOptions()).catch((error) => {
      log.error({
        event: 'desktop.window.reopen.failed',
        message: 'Main window reopen failed',
        error,
      });
    });
  }

  private installAppLifecycle(): void {
    app.on('activate', () => {
      this.summonMainWindow();
    });
    app.on('second-instance', () => {
      const session = this.options.windows.mainSession();
      if (!session || session.window.isDestroyed()) {
        if (this.ready && !this.quitting) {
          void this.options.windows.createMainWindow(this.mainWindowOptions()).catch((error) => {
            log.error({
              event: 'desktop.window.open.failed',
              message: 'Second instance window open failed',
              error,
            });
          });
        }
        return;
      }
      if (session.window.isMinimized()) session.window.restore();
      session.window.show();
      session.window.focus();
    });
    app.on('window-all-closed', () => {
      if (this.quitting) return;
      // 有托盘即退到托盘:窗口全没了也不退出,随时可从托盘重建;无托盘保持旧行为
      if (this.tray) return;
      if ((this.options.platform ?? process.platform) !== 'darwin') {
        void this.requestQuit('last-window-closed');
      }
    });
    app.on('before-quit', (event) => {
      event.preventDefault();
      void this.requestQuit('electron-before-quit');
    });
  }

  private installProcessDiagnostics(): void {
    app.on('child-process-gone', (_event, details) => {
      log.error({
        event: 'desktop.process.exit.failed',
        message: 'Electron child process exited unexpectedly',
        context: {
          processType: details.type,
          reason: details.reason,
          exitCode: details.exitCode,
          generation: this.options.backend.runtime.generation,
          quitting: this.quitting,
        },
      });
    });
    process.on('unhandledRejection', (reason) => {
      log.error({
        event: 'desktop.process.rejection.failed',
        message: 'Unhandled promise rejection',
        error: reason,
      });
    });
    process.on('uncaughtException', (error) => {
      log.error({
        event: 'desktop.process.exception.failed',
        message: 'Uncaught process exception',
        error,
      });
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void this.requestQuit(signal);
      });
    }
  }

  private currentIconPath(): string {
    if ((this.options.platform ?? process.platform) === 'win32') {
      return this.options.icons.windows;
    }
    return this.options.icons[this.colorScheme];
  }

  private createUpdateRuntime(): {
    updateProvider?: UpdateProvider;
    updateDisabledReason?: UpdateDisabledReason;
  } {
    const createProvider = this.options.updates?.createProvider;
    if (!createProvider) {
      return {
        updateDisabledReason: this.options.updates?.disabledReason
          ?? (this.options.appInfo.development ? 'development' : 'unpackaged'),
      };
    }
    try {
      return { updateProvider: createProvider() };
    } catch (error) {
      log.warn({
        event: 'desktop.updates.initialize.failed',
        message: 'Desktop update provider could not be initialized',
        error,
      });
      return { updateDisabledReason: 'unavailable' };
    }
  }

  private mainWindowOptions(): MainWindowOptions {
    return {
      ...this.options.mainWindow,
      iconPath: this.currentIconPath(),
    };
  }

  private async stopNow(reason: string): Promise<DesktopShutdownResult> {
    const failures: unknown[] = [];
    try {
      this.application?.dispose();
      this.application = undefined;
    } catch (error) {
      failures.push(error);
    }
    try {
      this.tray?.dispose();
      this.tray = undefined;
    } catch (error) {
      failures.push(error);
    }
    await this.configServer?.stop().catch((error) => failures.push(error));
    this.configServer = undefined;
    await this.portServer?.stop(reason).catch((error) => failures.push(error));
    await this.options.windows.stop(reason).catch((error) => failures.push(error));

    let backend: ShutdownReport | undefined;
    try {
      backend = await this.options.backend.runtime.stop(reason);
    } catch (error) {
      failures.push(error);
    }
    const exitCode =
      reason !== 'desktop-startup-failed' && failures.length === 0 && backend?.phase === 'stopped'
        ? 0
        : 1;
    log.info({
      event: 'desktop.runtime.stop.completed',
      message: 'Desktop runtime stopped',
      context: {
        reason,
        exitCode,
        backendPhase: backend?.phase,
        failureCount: failures.length,
      },
    });
    await closeAppLog().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[app-log] Shutdown flush failed: ${detail.slice(0, 512)}\n`);
    });
    app.exit(exitCode);
    return Object.freeze({ exitCode, backend });
  }
}
