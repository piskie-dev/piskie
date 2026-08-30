import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { linkAbort } from '../../../utils/abort.js';
import { createTreeKiller } from '../../shell/kill-tree.js';

export const DEFAULT_SCAN_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
let cachedRgPath: string | undefined;

export type RgTermination = 'timeout' | 'abort' | 'early-stop' | 'buffer-limit' | null;

export type RgOutcome = Readonly<{
  exitCode: number | null;
  stderr: string;
  terminated: RgTermination;
  treeKillFailed: boolean;
}>;

export function getRgPath(): string {
  if (cachedRgPath) return cachedRgPath;
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const platformPackage = `@vscode/ripgrep-${process.platform}-${process.arch}`;
  const require = createRequire(import.meta.url);
  let resolved: string;
  try {
    resolved = require.resolve(`${platformPackage}/bin/${binaryName}`);
  } catch {
    throw new Error(
      `ripgrep binary not found: ${platformPackage} is not installed for ${process.platform}-${process.arch}`,
    );
  }
  const asar = `${path.sep}app.asar${path.sep}`;
  cachedRgPath = resolved.includes(asar)
    ? resolved.replace(asar, `${path.sep}app.asar.unpacked${path.sep}`)
    : resolved;
  return cachedRgPath;
}

export function stderrSnippet(stderr: string, maxChars = 2_000): string {
  const value = stderr.trim();
  return value.length > maxChars
    ? `${value.slice(0, maxChars)}\n[stderr truncated: ${value.length} chars total]`
    : value;
}

/** Runs ripgrep with argv-only input and streams complete stdout lines. */
export function runRg(
  args: readonly string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    onLine(line: string): boolean | void;
  },
): Promise<RgOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(getRgPath(), [...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: os.platform() !== 'win32',
    });
    let terminated: RgTermination = null;
    let stderr = '';
    let lineBuffer = '';
    let settled = false;

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      disposeAbort();
      treeKiller.dispose();
      finish();
    };
    const treeKiller = createTreeKiller(child, {
      onWindowsFallbackDeadline: () => settle(() => resolve({
        exitCode: null,
        stderr,
        terminated,
        treeKillFailed: true,
      })),
    });
    const terminate = (reason: Exclude<RgTermination, null>): void => {
      if (terminated) return;
      terminated = reason;
      treeKiller.kill();
    };
    const timeout = setTimeout(
      () => terminate('timeout'),
      options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
    );
    const disposeAbort = linkAbort(options.signal, () => terminate('abort'));

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (terminated) return;
      lineBuffer += chunk;
      let newline = lineBuffer.indexOf('\n');
      while (newline >= 0) {
        let line = lineBuffer.slice(0, newline);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        lineBuffer = lineBuffer.slice(newline + 1);
        if (options.onLine(line) === false) {
          terminate('early-stop');
          return;
        }
        newline = lineBuffer.indexOf('\n');
      }
      if (Buffer.byteLength(lineBuffer, 'utf8') > MAX_BUFFER_BYTES) {
        terminate('buffer-limit');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (Buffer.byteLength(stderr, 'utf8') < MAX_BUFFER_BYTES) stderr += chunk;
    });
    child.on('close', (code) => {
      treeKiller.onParentClose();
      if (!terminated && lineBuffer.length > 0) options.onLine(lineBuffer);
      settle(() => resolve({
        exitCode: code,
        stderr,
        terminated,
        treeKillFailed: treeKiller.treeKillFailed,
      }));
    });
    child.on('error', (error) => settle(() => reject(error)));
  });
}
