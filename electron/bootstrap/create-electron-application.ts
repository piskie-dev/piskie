import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { setPilotRoot } from '../piskiepilot/paths.js';
import { createBackendComposition } from '../runtime/backend-composition.js';
import { DesktopRuntime } from '../desktop/desktop-runtime.js';
import { WindowRegistry } from '../desktop/window-registry.js';
import { appLog, installAppLogSink } from '../observability/logging/app-log.js';
import { createBootstrapLogSink } from './bootstrap-log-sink.js';
import { installEarlyElectronPolicy } from './early-policy.js';
import { resolveRuntimeProfile } from './runtime-profile.js';

export function createElectronApplication(): DesktopRuntime | undefined {
  const earlyPolicy = installEarlyElectronPolicy();
  if (!earlyPolicy.primaryInstance) {
    app.exit(0);
    return undefined;
  }

  const userDataDirectory = app.getPath('userData');
  const appPath = app.getAppPath();
  const profile = resolveRuntimeProfile({
    env: process.env,
    appPath,
  });
  const version = app.getVersion();
  installLogging({
    userDataDirectory,
    level: profile.logLevel,
    service: app.getName(),
    version,
  });
  if (profile.sandboxFallback) {
    appLog.warn({
      event: 'desktop.sandbox.fallback.enabled',
      message: 'Electron sandbox fallback enabled',
      context: {
        scope: 'desktop.sandbox',
        fallbackReason: 'linux-sandbox-unavailable',
      },
    });
  }
  if (profile.logLevelIssue) {
    appLog.warn({
      event: 'desktop.logging.level.rejected',
      message: 'Invalid log level was ignored',
      context: {
        scope: 'desktop.logging',
        requestedLevel: profile.logLevelIssue.requestedLevel,
        selectedLevel: profile.logLevel,
      },
    });
  }
  setPilotRoot(path.join(userDataDirectory, 'piskiepilot'));
  const backend = createBackendComposition({
    userDataDirectory,
  });
  const windows = new WindowRegistry({
    rendererUrl: profile.rendererEntryUrl,
    rendererBuildId: version,
    platform: process.platform,
  });
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

  return new DesktopRuntime({
    backend,
    windows,
    appInfo: {
      name: app.getName(),
      version,
      development: profile.development,
    },
    platform: process.platform,
    mainWindow: {
      rendererUrl: profile.rendererEntryUrl,
      preloadPath: path.resolve(currentDirectory, '..', 'preload.cjs'),
      development: profile.development,
    },
    icons: {
      light: path.join(appPath, 'logos', 'piskie', 'app', 'piskie-brand-on-light-256.png'),
      dark: path.join(appPath, 'logos', 'piskie', 'app', 'piskie-brand-on-dark-256.png'),
      windows: path.join(appPath, 'logos', 'piskie', 'app', 'piskie-brand.ico'),
      trayGlyphs: {
        light: path.join(appPath, 'logos', 'piskie', 'app', 'piskie-tray-glyph-128.png'),
        dark: path.join(appPath, 'logos', 'piskie', 'app', 'piskie-tray-glyph-dark-128.png'),
      },
    },
  });
}

function installLogging(input: {
  userDataDirectory: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;
  version: string;
}): void {
  const sink = createBootstrapLogSink({
    directory: path.join(input.userDataDirectory, 'logs', 'app'),
    level: input.level,
  });
  installAppLogSink(sink, {
    origin: 'main',
    defaultContext: {
      service: input.service,
      version: input.version,
      processId: process.pid,
    },
  });
}
