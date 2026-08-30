import { createUuid } from '@shared/utils/identifiers.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHELL_ENV_CAPTURE_TIMEOUT_MS = 10_000;
export const SHELL_ENV_CAPTURE_MAX_OUTPUT_BYTES = 1024 * 1024;

const CAPTURE_MARKER_ENV = 'PISKIE_ENV_CAPTURE_MARKER';
const CAPTURE_EXECUTABLE_ENV = 'PISKIE_ENV_CAPTURE_EXECUTABLE';
const CAPTURE_HELPER_ENV = 'PISKIE_ENV_CAPTURE_HELPER';
const CAPTURE_COMMAND = `export ELECTRON_RUN_AS_NODE=1; exec "$${CAPTURE_EXECUTABLE_ENV}" "$${CAPTURE_HELPER_ENV}"`;
const SUPPORTED_SHELLS = new Set(['bash', 'sh', 'zsh']);

export type StringEnvironment = Record<string, string>;

export type ShellEnvironmentCaptureFailureCode =
  | 'unsupported_shell'
  | 'shell_not_found'
  | 'spawn_failed'
  | 'timeout'
  | 'output_limit'
  | 'exit_failed'
  | 'marker_missing'
  | 'payload_invalid';

export class ShellEnvironmentCaptureError extends Error {
  constructor(
    readonly code: ShellEnvironmentCaptureFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShellEnvironmentCaptureError';
  }
}

export interface ShellCaptureProcessRequest {
  shell: string;
  args: string[];
  environment: StringEnvironment;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ShellCaptureProcessRunner = (request: ShellCaptureProcessRequest) => Promise<string>;

export interface CaptureLoginShellEnvironmentOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  shell?: string;
  executablePath?: string;
  helperPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  marker?: string;
  runProcess?: ShellCaptureProcessRunner;
}

export interface CapturedLoginShellEnvironment {
  environment: StringEnvironment;
  shell: string;
}

export type HostEnvironmentCaptureStatus =
  | Readonly<{
    state: 'uninitialized';
    source: 'process';
    variableCount: number;
  }>
  | Readonly<{
    state: 'captured';
    source: 'shell';
    variableCount: number;
    shell: string;
    durationMs: number;
  }>
  | Readonly<{
    state: 'fallback';
    source: 'process';
    variableCount: number;
    shell?: string;
    durationMs: number;
    failureCode: ShellEnvironmentCaptureFailureCode | 'unexpected';
    failureReason: string;
  }>
  | Readonly<{
    state: 'system';
    source: 'process';
    variableCount: number;
    durationMs: number;
  }>;

export interface ResolvedHostEnvironment {
  environment: StringEnvironment;
  status: HostEnvironmentCaptureStatus;
}

interface RuntimePathPrepend {
  directory: string;
  platform: NodeJS.Platform;
}

let hostEnvironmentSnapshot: Readonly<StringEnvironment> | undefined;
let captureStatus: HostEnvironmentCaptureStatus = Object.freeze({
  state: 'uninitialized',
  source: 'process',
  variableCount: 0,
});
let initializationPromise: Promise<HostEnvironmentCaptureStatus> | undefined;
const runtimePathPrepends = new Map<string, RuntimePathPrepend>();

function copyEnvironment(environment: NodeJS.ProcessEnv): StringEnvironment {
  const copy: StringEnvironment = Object.create(null);
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) copy[name] = value;
  }
  return copy;
}

function normalizeEnvironmentPath(value: string, platform: NodeJS.Platform): string {
  const normalized = platform === 'win32' ? path.win32.normalize(value) : path.posix.normalize(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function prependToPath(
  environment: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!directory) return;

  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === 'path')
    ?? (platform === 'win32' ? 'Path' : 'PATH');
  const delimiter = platform === 'win32' ? ';' : ':';
  const current = environment[key] ?? '';
  const normalizedDirectory = normalizeEnvironmentPath(directory, platform);
  const entries = current
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => normalizeEnvironmentPath(entry, platform) !== normalizedDirectory);
  environment[key] = [directory, ...entries].join(delimiter);
}

/** Registers a host-owned PATH entry that must survive replay of the login environment snapshot. */
export function registerHostRuntimePath(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!directory) return;

  const identity = `${platform}\0${normalizeEnvironmentPath(directory, platform)}`;
  runtimePathPrepends.delete(identity);
  runtimePathPrepends.set(identity, { directory, platform });
}

function applyRuntimePathPrepends(environment: StringEnvironment): StringEnvironment {
  for (const entry of runtimePathPrepends.values()) {
    prependToPath(environment, entry.directory, entry.platform);
  }
  return environment;
}

function validEnvironmentName(name: string): boolean {
  return name.length > 0 && !name.includes('=') && !name.includes('\0');
}

function environmentFromPayload(value: unknown): StringEnvironment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ShellEnvironmentCaptureError('payload_invalid', 'Shell environment payload is not an object.');
  }

  const environment: StringEnvironment = Object.create(null);
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!validEnvironmentName(name) || typeof entry !== 'string' || entry.includes('\0')) {
      throw new ShellEnvironmentCaptureError('payload_invalid', 'Shell environment payload contains an invalid entry.');
    }
    environment[name] = entry;
  }
  return environment;
}

export function parseShellEnvironmentOutput(stdout: string, marker: string): StringEnvironment {
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new ShellEnvironmentCaptureError('marker_missing', 'Shell environment marker was not found.');
  }

  const payloadStart = markerIndex + marker.length;
  const lineEnd = stdout.indexOf('\n', payloadStart);
  const encoded = stdout.slice(payloadStart, lineEnd < 0 ? undefined : lineEnd).trim();
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new ShellEnvironmentCaptureError('payload_invalid', 'Shell environment payload is not valid Base64.');
  }

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return environmentFromPayload(JSON.parse(decoded));
  } catch (error) {
    if (error instanceof ShellEnvironmentCaptureError) throw error;
    throw new ShellEnvironmentCaptureError('payload_invalid', 'Shell environment payload is not valid JSON.');
  }
}

function defaultShell(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

export function resolveLoginShell(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fileExists: (file: string) => boolean = existsSync,
): string {
  const configured = environment.SHELL;
  const shell = configured || defaultShell(platform);
  const shellName = path.basename(shell);
  if (!path.isAbsolute(shell) || !SUPPORTED_SHELLS.has(shellName)) {
    throw new ShellEnvironmentCaptureError(
      'unsupported_shell',
      `Shell environment capture supports bash, sh, and zsh; received ${shellName || 'unknown'}.`,
    );
  }
  if (!fileExists(shell)) {
    throw new ShellEnvironmentCaptureError('shell_not_found', `Login shell was not found at ${shell}.`);
  }
  return shell;
}

function killCaptureTree(child: ChildProcess): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The process may already have exited or may not own a process group.
    }
  }
  child.kill('SIGKILL');
}

export function runShellCaptureProcess(request: ShellCaptureProcessRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const child = spawn(request.shell, request.args, {
      detached: process.platform !== 'win32',
      env: request.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const fail = (error: ShellEnvironmentCaptureError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killCaptureTree(child);
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new ShellEnvironmentCaptureError(
        'timeout',
        `Login shell did not finish environment capture within ${request.timeoutMs}ms.`,
      ));
    }, request.timeoutMs);
    const capture = (chunk: Buffer | string, keep: boolean): void => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > request.maxOutputBytes) {
        fail(new ShellEnvironmentCaptureError(
          'output_limit',
          `Login shell environment output exceeded ${request.maxOutputBytes} bytes.`,
        ));
        return;
      }
      if (keep) stdoutChunks.push(buffer);
    };

    child.stdout?.on('data', (chunk: Buffer | string) => capture(chunk, true));
    child.stderr?.on('data', (chunk: Buffer | string) => capture(chunk, false));
    child.on('error', (error: NodeJS.ErrnoException) => {
      fail(new ShellEnvironmentCaptureError(
        'spawn_failed',
        `Login shell environment capture could not start${error.code ? ` (${error.code})` : ''}.`,
      ));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new ShellEnvironmentCaptureError(
          'exit_failed',
          `Login shell environment capture exited unsuccessfully (${code ?? signal ?? 'unknown'}).`,
        ));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString('utf8'));
    });
  });
}

export async function captureLoginShellEnvironment(
  options: CaptureLoginShellEnvironmentOptions = {},
): Promise<CapturedLoginShellEnvironment> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    throw new ShellEnvironmentCaptureError('unsupported_shell', 'Windows does not use login shell capture.');
  }

  const baseEnvironment = copyEnvironment(options.environment ?? process.env);
  const shell = options.shell ?? resolveLoginShell(baseEnvironment, platform);
  const marker = options.marker ?? `__PISKIE_ENV_${createUuid().replaceAll('-', '')}__:`;
  const helperPath = options.helperPath
    ?? fileURLToPath(new URL('./shell-env-helper.js', import.meta.url));
  const executablePath = options.executablePath ?? process.execPath;
  const environment: StringEnvironment = {
    ...baseEnvironment,
    [CAPTURE_MARKER_ENV]: marker,
    [CAPTURE_EXECUTABLE_ENV]: executablePath,
    [CAPTURE_HELPER_ENV]: helperPath,
  };
  const stdout = await (options.runProcess ?? runShellCaptureProcess)({
    shell,
    args: ['-ilc', CAPTURE_COMMAND],
    environment,
    timeoutMs: options.timeoutMs ?? SHELL_ENV_CAPTURE_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? SHELL_ENV_CAPTURE_MAX_OUTPUT_BYTES,
  });
  return { environment: parseShellEnvironmentOutput(stdout, marker), shell };
}

function installHostEnvironment(environment: StringEnvironment): void {
  hostEnvironmentSnapshot = Object.freeze({ ...environment });
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;
}

export async function resolveHostEnvironment(
  options: CaptureLoginShellEnvironmentOptions,
): Promise<ResolvedHostEnvironment> {
  const startedAt = Date.now();
  const platform = options.platform ?? process.platform;
  const baseEnvironment = copyEnvironment(options.environment ?? process.env);

  if (platform === 'win32') {
    return {
      environment: baseEnvironment,
      status: Object.freeze({
        state: 'system',
        source: 'process',
        variableCount: Object.keys(baseEnvironment).length,
        durationMs: Date.now() - startedAt,
      }),
    };
  }

  try {
    const captured = await captureLoginShellEnvironment({ ...options, environment: baseEnvironment, platform });
    const merged = { ...baseEnvironment, ...captured.environment };
    return {
      environment: merged,
      status: Object.freeze({
        state: 'captured',
        source: 'shell',
        variableCount: Object.keys(merged).length,
        shell: captured.shell,
        durationMs: Date.now() - startedAt,
      }),
    };
  } catch (error) {
    return {
      environment: baseEnvironment,
      status: Object.freeze({
        state: 'fallback',
        source: 'process',
        variableCount: Object.keys(baseEnvironment).length,
        shell: options.shell ?? baseEnvironment.SHELL,
        durationMs: Date.now() - startedAt,
        failureCode: error instanceof ShellEnvironmentCaptureError ? error.code : 'unexpected',
        failureReason: error instanceof Error ? error.message : 'Unknown shell environment capture failure.',
      }),
    };
  }
}

async function initializeOnce(
  options: CaptureLoginShellEnvironmentOptions,
): Promise<HostEnvironmentCaptureStatus> {
  const resolved = await resolveHostEnvironment(options);
  installHostEnvironment(resolved.environment);
  captureStatus = resolved.status;
  return captureStatus;
}

/** Initializes exactly once for the lifetime of the Piskie main process. */
export function initializeHostEnvironment(
  options: CaptureLoginShellEnvironmentOptions = {},
): Promise<HostEnvironmentCaptureStatus> {
  initializationPromise ??= initializeOnce(options);
  return initializationPromise;
}

/** CLI processes that do not run the Electron bootstrap inherit their current terminal environment. */
export function getHostEnvironment(): StringEnvironment {
  const environment = hostEnvironmentSnapshot
    ? { ...hostEnvironmentSnapshot }
    : copyEnvironment(process.env);
  return applyRuntimePathPrepends(environment);
}

export function getHostEnvironmentVariable(name: string): string | undefined {
  const environment = getHostEnvironment();
  if (process.platform !== 'win32') return environment[name];
  const key = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? environment[key] : undefined;
}
