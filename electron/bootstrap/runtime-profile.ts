import { resolveRendererEntryUrl } from './renderer-entry.js';

export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeProfile {
  readonly accountBaseUrl: string;
  readonly development: boolean;
  readonly sandboxFallback: boolean;
  readonly rendererEntryUrl: string;
  readonly logLevel: RuntimeLogLevel;
  readonly logLevelIssue?: {
    readonly requestedLevel: string;
  };
}

export interface RuntimeEnvironment {
  readonly NODE_ENV?: string;
  readonly PISKIE_ACCOUNT_BASE_URL?: string;
  readonly PISKIE_ELECTRON_SANDBOX_FALLBACK?: string;
  readonly PISKIE_LOG_LEVEL?: string;
  readonly PISKIE_RENDERER_URL?: string;
}

const LOG_LEVELS = new Set<RuntimeLogLevel>(['debug', 'info', 'warn', 'error']);
const PRODUCTION_ACCOUNT_BASE_URL = 'https://www.piskie.dev';

function resolveAccountBaseUrl(development: boolean, override?: string): string {
  if (!development || !override) return PRODUCTION_ACCOUNT_BASE_URL;

  let target: URL;
  try {
    target = new URL(override);
  } catch {
    throw new Error('PISKIE_ACCOUNT_BASE_URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('PISKIE_ACCOUNT_BASE_URL must be an HTTP(S) URL without credentials');
  }
  if (target.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
    throw new Error('PISKIE_ACCOUNT_BASE_URL must use HTTPS unless it targets localhost');
  }
  target.pathname = target.pathname.replace(/\/+$/, '') || '/';
  target.search = '';
  target.hash = '';
  return target.toString().replace(/\/$/, '');
}

export function resolveRuntimeProfile(input: {
  env: RuntimeEnvironment;
  appPath: string;
}): RuntimeProfile {
  const development = input.env.NODE_ENV === 'development';
  const requestedLogLevel = input.env.PISKIE_LOG_LEVEL;
  const validLogLevel = requestedLogLevel
    ? LOG_LEVELS.has(requestedLogLevel as RuntimeLogLevel)
    : false;
  const logLevel = validLogLevel
    ? (requestedLogLevel as RuntimeLogLevel)
    : development
      ? 'debug'
      : 'info';

  return Object.freeze({
    accountBaseUrl: resolveAccountBaseUrl(development, input.env.PISKIE_ACCOUNT_BASE_URL),
    development,
    sandboxFallback: input.env.PISKIE_ELECTRON_SANDBOX_FALLBACK === '1',
    rendererEntryUrl: resolveRendererEntryUrl({
      development,
      appPath: input.appPath,
      devServerUrl: development ? input.env.PISKIE_RENDERER_URL : undefined,
    }),
    logLevel,
    ...(requestedLogLevel &&
      !validLogLevel && {
        logLevelIssue: Object.freeze({ requestedLevel: requestedLogLevel }),
      }),
  });
}
