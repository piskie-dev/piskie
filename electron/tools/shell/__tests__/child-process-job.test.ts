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

describe('ChildProcessJob output completeness', () => {
  it.each([
    { name: 'empty output', output: '', tail: '', truncated: false },
    { name: 'multiple lines', output: 'First line\nSecond line\n  \n', tail: 'First line\nSecond line\n  \n', truncated: false },
    { name: 'one byte below the limit', output: 'a'.repeat(16_383), tail: 'a'.repeat(16_383), truncated: false },
    { name: 'exactly the limit', output: 'b'.repeat(16_384), tail: 'b'.repeat(16_384), truncated: false },
    { name: 'one byte above the limit', output: 'c' + 'd'.repeat(16_384), tail: 'd'.repeat(16_384), truncated: true },
    { name: 'multiple captured chunks', output: 'older\n'.repeat(20_000) + 'e'.repeat(16_383) + '\n', tail: 'e'.repeat(16_383) + '\n', truncated: true },
    { name: 'UTF-8 byte limit', output: 'é'.repeat(9_000), tail: 'é'.repeat(8_192), truncated: true },
    { name: 'stderr output', output: 'older\n' + 'f'.repeat(16_384), tail: 'f'.repeat(16_384), truncated: true, stderr: true },
  ])('reports $name without losing the complete log', async (sample) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sample-command-output-'));
    await fs.writeFile(path.join(tempDir, 'sample-output.txt'), sample.output, 'utf8');
    const job = new ChildProcessJob({
      command: process.platform === 'win32'
        ? `[Console]::${sample.stderr ? 'Error.Write' : 'Write'}([IO.File]::ReadAllText('sample-output.txt'))`
        : `cat sample-output.txt${sample.stderr ? ' >&2' : ''}`,
      cwd: tempDir,
      tempDir,
    });

    try {
      const outcome = await job.exited();
      expect(outcome).toMatchObject({
        status: 'ok', exitCode: 0, tail: sample.tail, outputTruncated: sample.truncated,
      });
      await expect(fs.readFile(job.outFile, 'utf8')).resolves.toBe(sample.output);
    } finally {
      await job.kill();
      await job.removeOutputFile();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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
