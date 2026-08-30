import { createUuid } from '@shared/utils/identifiers.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { getHostEnvironment } from '../../environment/host-environment.js';
import type { BackgroundJob, OutputSpoolPort } from '../types.js';
import { createTreeKiller, type TreeKiller } from './kill-tree.js';

const TAIL_BYTES = 16 * 1024;
const WINDOWS_POWERSHELL_COMMAND = [
  '$utf8 = New-Object System.Text.UTF8Encoding($false)',
  '[Console]::InputEncoding = $utf8',
  '[Console]::OutputEncoding = $utf8',
  '$OutputEncoding = $utf8',
  '$command = [Console]::In.ReadToEnd()',
  '$command += "`nif (-not `$?) { exit 1 }"',
  '& ([System.Management.Automation.ScriptBlock]::Create($command))',
].join('; ');

export type ShellInvocation = Readonly<{
  executable: string;
  args: string[];
  stdin?: string;
}>;

export function resolveShellInvocation(
  command: string,
  platform: NodeJS.Platform = os.platform(),
): ShellInvocation {
  if (platform !== 'win32') {
    return { executable: '/bin/bash', args: ['-c', command] };
  }

  // Parse the model command only after PowerShell is emitting UTF-8 diagnostics.
  return {
    executable: 'powershell.exe',
    args: ['-WindowStyle', 'Hidden', '-NoProfile', '-Command', WINDOWS_POWERSHELL_COMMAND],
    stdin: command,
  };
}

export type ChildProcessExit = Awaited<ReturnType<BackgroundJob['exited']>>;

export class ChildProcessJob implements BackgroundJob {
  readonly outFile: string;
  private readonly child: ChildProcess;
  private readonly startedAt = Date.now();
  private readonly treeKiller: TreeKiller;
  private readonly exitPromise: Promise<ChildProcessExit>;
  private resolveExit!: (value: ChildProcessExit) => void;
  private fd: number;
  private tail = Buffer.alloc(0);
  private settled = false;
  private killRequested = false;
  private spool?: OutputSpoolPort;

  constructor(options: {
    command: string;
    cwd: string;
    tempDir: string;
    spool?: OutputSpoolPort;
    onWarning?: (message: string, error?: unknown) => void;
  }) {
    const id = createUuid();
    const outputDirectory = path.join(options.tempDir, 'bg');
    fs.mkdirSync(outputDirectory, { recursive: true });
    this.outFile = path.join(outputDirectory, `${id}.log`);
    this.fd = fs.openSync(this.outFile, 'wx', 0o600);
    this.spool = options.spool;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });

    const platform = os.platform();
    const windows = platform === 'win32';
    const invocation = resolveShellInvocation(options.command, platform);
    this.child = spawn(invocation.executable, invocation.args, {
      cwd: options.cwd,
      env: getHostEnvironment(),
      stdio: [invocation.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !windows,
    });
    this.treeKiller = createTreeKiller(this.child, {
      onWindowsFallbackDeadline: () => this.finish({
        status: 'killed',
        durationMs: Date.now() - this.startedAt,
        tail: this.tail.toString('utf8'),
      }),
    });

    this.child.stdout?.on('data', (chunk: Buffer | string) => this.capture(chunk, 'out', options.onWarning));
    this.child.stderr?.on('data', (chunk: Buffer | string) => this.capture(chunk, 'err', options.onWarning));
    this.child.on('error', (error) => {
      this.capture(Buffer.from(`Failed to start command: ${error.message}\n`), 'err', options.onWarning);
      this.finish({
        status: this.killRequested ? 'killed' : 'failed',
        durationMs: Date.now() - this.startedAt,
        tail: this.tail.toString('utf8'),
      });
    });
    this.child.on('close', (code, signal) => {
      this.treeKiller.onParentClose();
      const exitCode = code ?? (signal ? 128 : 1);
      this.finish({
        status: this.killRequested ? 'killed' : exitCode === 0 ? 'ok' : 'failed',
        exitCode,
        durationMs: Date.now() - this.startedAt,
        tail: this.tail.toString('utf8'),
      });
    });
    if (invocation.stdin !== undefined) {
      this.child.stdin?.on('error', (error) => {
        options.onWarning?.('Failed sending command to Windows PowerShell', error);
      });
      this.child.stdin?.end(invocation.stdin, 'utf8');
    }
  }

  exited(): Promise<ChildProcessExit> {
    return this.exitPromise;
  }

  async kill(): Promise<void> {
    if (this.settled) return;
    this.killRequested = true;
    this.treeKiller.kill();
    await this.exitPromise;
  }

  /** Stop writing the activation-owned spool after background ownership transfer. */
  detachSpool(): void {
    this.spool?.dispose();
    this.spool = undefined;
  }

  async removeOutputFile(): Promise<void> {
    await this.exitPromise;
    await fs.promises.unlink(this.outFile).catch(() => undefined);
  }

  private capture(
    value: Buffer | string,
    stream: 'out' | 'err',
    onWarning: ((message: string, error?: unknown) => void) | undefined,
  ): void {
    if (this.settled) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    try {
      fs.writeSync(this.fd, chunk);
    } catch (error) {
      onWarning?.(`Failed writing command output to ${this.outFile}`, error);
    }
    try {
      this.spool?.write(chunk, stream);
    } catch (error) {
      onWarning?.('Failed writing command output to its OutputSpool', error);
      this.spool = undefined;
    }
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > TAIL_BYTES) {
      this.tail = this.tail.subarray(this.tail.length - TAIL_BYTES);
    }
  }

  private finish(outcome: ChildProcessExit): void {
    if (this.settled) return;
    this.settled = true;
    this.treeKiller.dispose();
    try { fs.fsyncSync(this.fd); } catch { /* output remains best effort */ }
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
    this.resolveExit(outcome);
  }
}
