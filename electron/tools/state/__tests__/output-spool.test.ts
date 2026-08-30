import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { persistOverflow } from '../../pipeline/persist-overflow.js';
import { toToolResult } from '../../types.js';
import { renderToolResult } from '../../../agent/conversation/model-text.js';
import { OutputSpool } from '../output-spool.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});
vi.mock('@electron/observability/logging/app-log.js', () => ({
  appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import { appLog } from '@electron/observability/logging/app-log.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-spool-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('OutputSpool -> ToolResult', () => {
  it('keeps exactly 64 KiB in memory and spills only after the default boundary', () => {
    const inlineDir = makeTempDir();
    const inline = new OutputSpool({ tempDir: inlineDir, minFreeDiskBytes: 0 });
    inline.write(Buffer.alloc(64 * 1024, 0x61), 'out');

    expect(inline.spilled()).toBeNull();
    expect(Buffer.byteLength(inline.textForModel(), 'utf8')).toBe(64 * 1024);
    expect(fs.readdirSync(inlineDir)).toEqual([]);

    const spilledDir = makeTempDir();
    const overflow = new OutputSpool({ tempDir: spilledDir, minFreeDiskBytes: 0 });
    overflow.write(Buffer.alloc(64 * 1024 + 1, 0x62), 'out');

    const report = overflow.spilled();
    expect(report?.bytes).toBe(64 * 1024 + 1);
    expect(fs.statSync(report!.path).size).toBe(64 * 1024 + 1);
  });

  it('persists finalized text only when it exceeds the default 64 KiB boundary', async () => {
    const tempDir = makeTempDir();
    const inline = toToolResult({ ok: true, text: 'x'.repeat(64 * 1024) });
    await persistOverflow(
      {
        ctx: {
          workspace: { dir: '/workspace', tempDir },
        } as never,
      },
      inline
    );
    expect(inline.persisted).toBeUndefined();

    const overflow = toToolResult({ ok: true, text: 'y'.repeat(64 * 1024 + 1) });
    await persistOverflow(
      {
        ctx: {
          workspace: { dir: '/workspace', tempDir },
        } as never,
      },
      overflow
    );

    expect(overflow.persisted?.bytes).toBe(64 * 1024 + 1);
    expect(fs.readFileSync(overflow.persisted!.path, 'utf8')).toBe(overflow.text);
  });

  it('streams the complete output to disk and exposes it through the sole finalizer', async () => {
    const tempDir = makeTempDir();
    const spool = new OutputSpool({
      tempDir,
      memoryLimitBytes: 8,
      previewBytes: 6,
      tailBytes: 6,
    });
    spool.write(Buffer.from('stdout-'), 'out');
    spool.write(Buffer.from('stderr-'), 'err');
    spool.write(Buffer.from('done'), 'out');

    const result = toToolResult({ ok: false, text: spool.textForModel() });
    await persistOverflow(
      {
        ctx: {
          workspace: { dir: '/workspace', tempDir },
          spool,
        } as never,
      },
      result
    );

    expect(result.persisted).toMatchObject({ bytes: 18, preview: 'stdout' });
    expect(fs.readFileSync(result.persisted!.path, 'utf8')).toBe('stdout-stderr-done');
    expect(result.ok).toBe(false);
  });

  it('falls back to the inline result if disk persistence fails', async () => {
    const warning = vi.fn();
    const result = toToolResult({ ok: true, text: 'large body' });
    await persistOverflow(
      {
        ctx: {
          workspace: { dir: '/workspace', tempDir: '/dev/null/not-a-directory' },
        } as never,
      },
      result,
      { maxInlineBytes: 1, onWarning: warning }
    );

    expect(result.persisted).toBeUndefined();
    expect(result.text).toBe('large body');
    expect(warning).toHaveBeenCalledOnce();
  });

  it('logs the call identity when production persistence fails without an override', async () => {
    const result = toToolResult({ ok: true, text: 'large body' });
    await persistOverflow(
      {
        ctx: {
          agentId: 'agent-1',
          callId: 'call-1',
          workspace: { dir: '/workspace', tempDir: '/dev/null/not-a-directory' },
        } as never,
      },
      result,
      { maxInlineBytes: 1 }
    );

    expect(result.persisted).toBeUndefined();
    expect(appLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tool.output.persist.degraded',
        message: 'Tool output persistence degraded',
        context: expect.objectContaining({
          scope: 'tool.output',
          agentId: 'agent-1',
          callId: 'call-1',
        }),
        error: expect.any(Error),
      })
    );
  });

  it('stops at the per-call disk quota without adding shared counters', () => {
    const tempDir = makeTempDir();
    const warning = vi.fn();
    const spool = new OutputSpool({
      tempDir,
      memoryLimitBytes: 4,
      previewBytes: 4,
      tailBytes: 6,
      callDiskLimitBytes: 10,
      globalDiskLimitBytes: 1_000,
      minFreeDiskBytes: 0,
      onWarning: warning,
    });

    spool.write(Buffer.from('abcdefgh'), 'out');
    spool.write(Buffer.from('ijklmnop'), 'out');

    const spilled = spool.spilled();
    expect(spilled).toMatchObject({
      bytes: 10,
      preview: 'abcd',
      incomplete: { observedBytes: 16, reason: '达到单次调用输出磁盘配额' },
    });
    expect(fs.readFileSync(spilled!.path, 'utf8')).toBe('abcdefghij');
    expect(spool.textForModel()).toContain('中间内容已丢失');
    const rendered = renderToolResult(
      {
        ok: true,
        text: spool.textForModel(),
        persisted: spilled!,
      },
      'shell'
    );
    expect(rendered.content).toContain('Output incomplete');
    expect(rendered.content).toContain('Middle output was lost');
    expect(rendered.content).not.toContain('Full output saved');
    expect(warning).toHaveBeenCalledOnce();

    const source = fs.readFileSync(path.resolve('electron/tools/state/output-spool.ts'), 'utf8');
    expect(source).not.toContain('Map<');
  });

  it('samples the temp root to enforce the global disk quota', () => {
    const tempDir = makeTempDir();
    fs.writeFileSync(path.join(tempDir, 'existing.log'), '1234567');
    const spool = new OutputSpool({
      tempDir,
      tempRootDir: tempDir,
      memoryLimitBytes: 4,
      previewBytes: 4,
      tailBytes: 4,
      callDiskLimitBytes: 100,
      globalDiskLimitBytes: 12,
      minFreeDiskBytes: 0,
    });

    spool.write(Buffer.from('abcdefgh'), 'out');

    const spilled = spool.spilled();
    expect(spilled?.bytes).toBe(5);
    expect(fs.readFileSync(spilled!.path, 'utf8')).toBe('abcde');
    expect(spool.textForModel()).toContain('全局输出磁盘配额');
  });

  it('degrades ENOSPC to a bounded head/tail result and warning', () => {
    const tempDir = makeTempDir();
    const warning = vi.fn();
    vi.mocked(fs.writeSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    const spool = new OutputSpool({
      tempDir,
      memoryLimitBytes: 4,
      previewBytes: 4,
      tailBytes: 5,
      minFreeDiskBytes: 0,
      onWarning: warning,
    });

    expect(() => spool.write(Buffer.from('abcdefghijk'), 'out')).not.toThrow();

    expect(spool.spilled()).toBeNull();
    expect(spool.textForModel()).toContain('磁盘写入失败');
    expect(spool.textForModel()).toContain('中间内容已丢失');
    expect(warning).toHaveBeenCalledOnce();
  });

  it('removes an unreported spill but retains one claimed by the finalizer', () => {
    const tempDir = makeTempDir();
    const abandoned = new OutputSpool({ tempDir, memoryLimitBytes: 4, minFreeDiskBytes: 0 });
    abandoned.write(Buffer.from('abcdefgh'), 'out');
    const abandonedPath = fs
      .readdirSync(tempDir)
      .map((name) => path.join(tempDir, name))
      .find((candidate) => path.basename(candidate).startsWith('output-'))!;

    abandoned.dispose();
    expect(fs.existsSync(abandonedPath)).toBe(false);
    expect(abandoned.spilled()).toBeNull();

    const reported = new OutputSpool({ tempDir, memoryLimitBytes: 4, minFreeDiskBytes: 0 });
    reported.write(Buffer.from('ijklmnop'), 'out');
    const report = reported.spilled();
    reported.dispose();

    expect(report).not.toBeNull();
    expect(fs.readFileSync(report!.path, 'utf8')).toBe('ijklmnop');
  });

  it('does not give the spool ownership of the result field', () => {
    const source = fs.readFileSync(path.resolve('electron/tools/state/output-spool.ts'), 'utf8');
    expect(source.toLowerCase()).not.toContain('persisted');
  });
});
