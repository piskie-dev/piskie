import { resolveRendererEntryUrl } from './renderer-entry.js';

export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeProfile {
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
  readonly PISKIE_ELECTRON_SANDBOX_FALLBACK?: string;
  readonly PISKIE_LOG_LEVEL?: string;
  readonly PISKIE_RENDERER_URL?: string;
}

const LOG_LEVELS = new Set<RuntimeLogLevel>(['debug', 'info', 'warn', 'error']);

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
