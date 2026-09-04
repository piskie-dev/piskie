import electronUpdater, {
  type AppUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from 'electron-updater';

import { appLog } from '../observability/logging/app-log.js';
import type {
  UpdateDownloadProgress,
  UpdateProvider,
  UpdateProviderEvent,
  UpdateRelease,
} from './update-provider.js';

const log = appLog.child({ scope: 'desktop.updates.provider' });

export function createElectronUpdateProvider(updater: AppUpdater = electronUpdater.autoUpdater): UpdateProvider {
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.fullChangelog = false;
  updater.disableWebInstaller = true;
  updater.logger = {
    debug: (message) => providerLog('debug', message),
    info: (message) => providerLog('info', message),
    warn: (message) => providerLog('warn', message),
    error: (message) => providerLog('error', message),
  };

  return Object.freeze({
    subscribe(listener: (event: UpdateProviderEvent) => void) {
      const handlers = {
        checking: (): void => listener({ type: 'checking' }),
        notAvailable: (): void => listener({ type: 'not-available' }),
        available: (info: UpdateInfo): void => listener({
          type: 'available',
          release: publicRelease(info),
        }),
        progress: (info: ProgressInfo): void => listener({
          type: 'progress',
          progress: publicProgress(info),
        }),
        downloaded: (info: UpdateDownloadedEvent): void => listener({
          type: 'downloaded',
          release: publicRelease(info),
        }),
        error: (error: Error): void => listener({ type: 'error', error }),
      };
      updater.on('checking-for-update', handlers.checking);
      updater.on('update-not-available', handlers.notAvailable);
      updater.on('update-available', handlers.available);
      updater.on('download-progress', handlers.progress);
      updater.on('update-downloaded', handlers.downloaded);
      updater.on('error', handlers.error);
      return () => {
        updater.removeListener('checking-for-update', handlers.checking);
        updater.removeListener('update-not-available', handlers.notAvailable);
        updater.removeListener('update-available', handlers.available);
        updater.removeListener('download-progress', handlers.progress);
        updater.removeListener('update-downloaded', handlers.downloaded);
        updater.removeListener('error', handlers.error);
      };
    },
    async checkForUpdates(): Promise<void> {
      const result = await updater.checkForUpdates();
      // electron-updater starts this promise without awaiting it when autoDownload is enabled.
      // Its error event updates public state; this handler prevents an unhandled rejection.
      void result?.downloadPromise?.catch(() => undefined);
    },
    quitAndInstall(): void {
      updater.quitAndInstall(false, true);
    },
  });
}

function publicRelease(info: UpdateInfo): UpdateRelease {
  return Object.freeze({
    version: info.version.slice(0, 64),
  });
}

function publicProgress(info: ProgressInfo): UpdateDownloadProgress {
  return Object.freeze({
    percent: finiteNonNegative(info.percent),
  });
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function providerLog(level: 'debug' | 'info' | 'warn' | 'error', value: unknown): void {
  log[level]({
    event: `desktop.updates.provider.${level}`,
    message: String(value ?? '').slice(0, 2_048) || 'Updater event',
  });
}
