import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChildProcessJob, resolveShellInvocation } from '../child-process-job.js';

describe('resolveShellInvocation', () => {
  it('passes Bash commands through -c on non-Windows platforms', () => {
    expect(resolveShellInvocation('printf test', 'linux')).toEqual({
      executable: '/bin/bash',
      args: ['-c', 'printf test'],
    });
  });

  it('sends Windows commands through stdin so UTF-8 is configured before parsing', () => {
    const command = "$rgba['r'] = 1 + ($rgba['r'] ?? 0)";
    const invocation = resolveShellInvocation(command, 'win32');

    expect(invocation.executable).toBe('powershell.exe');
    expect(invocation.stdin).toBe(command);
    expect(invocation.args).toEqual(expect.arrayContaining([
      '-NoProfile',
      '-Command',
      expect.stringContaining('[Console]::OutputEncoding = $utf8'),
    ]));
    expect(invocation.args.join(' ')).not.toContain(command);
  });
});

const windowsIt = process.platform === 'win32' ? it : it.skip;

describe('ChildProcessJob on Windows', () => {
  windowsIt('keeps Unicode readable in parser diagnostics', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-shell-utf8-'));
    const job = new ChildProcessJob({
      command: '$中文变量 = ??',
      cwd: tempDir,
      tempDir,
    });

    try {
      const outcome = await job.exited();
      const output = await fs.readFile(job.outFile, 'utf8');

      expect(outcome.status).toBe('failed');
      expect(output).toContain('中文变量');
      expect(output).not.toContain('\uFFFD');
    } finally {
      await job.removeOutputFile();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
