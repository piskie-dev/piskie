import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

import { writeAtomic } from '../../fs/_lib/file-io.js';
import { readBufferWithVersion, readTextWithVersion } from '../../fs/_lib/file-read.js';
import { ReadTool } from '../../fs/read.tool.js';
import type { FileGuardPort, GuardVerdict, VersionToken } from '../../types.js';
import { LedgerFileGuard, ReadLedger } from '../read-ledger.js';

const fsMocks = vi.hoisted(() => ({ link: vi.fn() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMocks.link.mockImplementation(actual.link);
  return { ...actual, link: fsMocks.link };
});

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-ledger-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeGuard(): LedgerFileGuard {
  return new LedgerFileGuard(new ReadLedger());
}

describe('per-agent file version guard', () => {
  it('records the fstat token at commit so write -> edit remains current', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'note.txt');
    const guard = makeGuard();

    expect(await guard.check(file)).toBe('absent');
    expect(await writeAtomic({ canonicalPath: file, content: 'v1', files: guard, expected: 'absent' }))
      .toEqual({ ok: true });
    expect(await guard.check(file)).toBe('current');
    expect(await writeAtomic({ canonicalPath: file, content: 'v2', files: guard, expected: 'current' }))
      .toEqual({ ok: true });
    expect(await guard.check(file)).toBe('current');
    expect(await fs.readFile(file, 'utf8')).toBe('v2');
  });

  it('blocks a change made after the early guard without modifying the file', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'note.txt');
    await fs.writeFile(file, 'read version');
    const guard = makeGuard();
    expect(await readTextWithVersion(file, guard)).toMatchObject({ kind: 'read', stable: true });
    expect(await guard.check(file)).toBe('current');

    await fs.writeFile(file, 'external change with another size');
    const committed = await writeAtomic({
      canonicalPath: file,
      content: 'model change',
      files: guard,
      expected: 'current',
    });
    expect(committed).toMatchObject({ ok: false, reason: 'staleAtCommit', verdict: 'stale' });
    expect(await fs.readFile(file, 'utf8')).toBe('external change with another size');
  });

  it('treats deletion after read as stale until a new read observes absence', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'note.txt');
    await fs.writeFile(file, 'v1');
    const guard = makeGuard();
    await readTextWithVersion(file, guard);
    await fs.unlink(file);

    expect(await guard.check(file)).toBe('stale');
    expect(await writeAtomic({ canonicalPath: file, content: 'wrong', files: guard, expected: 'absent' }))
      .toMatchObject({ ok: false, reason: 'staleAtCommit' });
    expect(await readTextWithVersion(file, guard)).toEqual({ kind: 'missing' });
    expect(await guard.check(file)).toBe('absent');
    expect(await writeAtomic({ canonicalPath: file, content: 'new', files: guard, expected: 'absent' }))
      .toEqual({ ok: true });
  });

  it('bounds binary reads on the opened inode and records only complete stable content', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'payload.bin');
    const guard = makeGuard();
    await fs.writeFile(file, Buffer.from('123456789'));

    expect(await readBufferWithVersion(file, guard, 8)).toEqual({
      kind: 'tooLarge',
      bytes: 9,
    });
    expect(await guard.check(file)).toBe('unread');

    const complete = await readBufferWithVersion(file, guard, 9);
    expect(complete).toMatchObject({ kind: 'read', stable: true });
    expect(complete.kind === 'read' && complete.buffer.toString()).toBe('123456789');
    expect(await guard.check(file)).toBe('current');
  });

  it('rejects an oversized image from the same bounded read used for model delivery', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'large.png');
    const guard = makeGuard();
    await fs.writeFile(file, Buffer.alloc(Math.floor(5 * 1024 * 1024 * 3 / 4) + 1));

    const output = await new ReadTool().execute({
      file_path: file,
      offset: 1,
      limit: 2_000,
    }, { files: guard } as never);

    expect(output.ok).toBe(false);
    expect(output.text).toContain('base64 后会超过 5MB');
    expect('images' in output).toBe(false);
    expect(await guard.check(file)).toBe('unread');
  });

  it('rejects a creator that loses the atomic link race', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'new.txt');
    const guard = makeGuard();
    const files: FileGuardPort = {
      ...guard,
      check: async () => {
        await fs.writeFile(file, 'created by someone else');
        return 'absent';
      },
      record: guard.record.bind(guard),
      forget: guard.forget.bind(guard),
    };

    expect(await writeAtomic({ canonicalPath: file, content: 'candidate', files, expected: 'absent' }))
      .toMatchObject({ ok: false, reason: 'createdMeanwhile' });
    expect(await fs.readFile(file, 'utf8')).toBe('created by someone else');
  });

  it('falls back to exclusive target creation when hard links are unsupported', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'new.txt');
    const guard = makeGuard();
    const warning = vi.fn();
    fsMocks.link.mockClear();
    fsMocks.link.mockRejectedValueOnce(
      Object.assign(new Error('hard links unavailable'), { code: 'EOPNOTSUPP' }),
    );

    expect(await writeAtomic({
      canonicalPath: file,
      content: 'fallback content',
      files: guard,
      expected: 'absent',
      onWarning: warning,
    })).toEqual({ ok: true });
    expect(fsMocks.link).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
    expect(await fs.readFile(file, 'utf8')).toBe('fallback content');
    expect(await guard.check(file)).toBe('current');
  });

  it('uses last-writer-wins only when both commit checks precede either rename', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'shared.txt');
    await fs.writeFile(file, 'v1');
    const guardA = makeGuard();
    const guardB = makeGuard();
    await Promise.all([readTextWithVersion(file, guardA), readTextWithVersion(file, guardB)]);

    let checks = 0;
    let release!: () => void;
    const bothChecked = new Promise<void>((resolve) => { release = resolve; });
    const barrier = (base: LedgerFileGuard): FileGuardPort => ({
      async check(canonicalPath: string): Promise<GuardVerdict> {
        const verdict = await base.check(canonicalPath);
        checks += 1;
        if (checks === 2) release();
        await bothChecked;
        return verdict;
      },
      record: base.record.bind(base),
      forget: base.forget.bind(base),
    });

    const [a, b] = await Promise.all([
      writeAtomic({ canonicalPath: file, content: 'complete-A', files: barrier(guardA), expected: 'current' }),
      writeAtomic({ canonicalPath: file, content: 'complete-B', files: barrier(guardB), expected: 'current' }),
    ]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    const final = await fs.readFile(file, 'utf8');
    expect(['complete-A', 'complete-B']).toContain(final);

    const verdicts = await Promise.all([guardA.check(file), guardB.check(file)]);
    expect(verdicts.sort()).toEqual(['current', 'stale']);
  });

  it('rejects the later writer when its commit check follows the first rename', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'shared.txt');
    await fs.writeFile(file, 'v1');
    const guardA = makeGuard();
    const guardB = makeGuard();
    await Promise.all([readTextWithVersion(file, guardA), readTextWithVersion(file, guardB)]);

    expect(await writeAtomic({ canonicalPath: file, content: 'A', files: guardA, expected: 'current' }))
      .toEqual({ ok: true });
    expect(await writeAtomic({ canonicalPath: file, content: 'B', files: guardB, expected: 'current' }))
      .toMatchObject({ ok: false, reason: 'staleAtCommit', verdict: 'stale' });
    expect(await fs.readFile(file, 'utf8')).toBe('A');
  });

  it('keeps version tokens fully bigint', () => {
    const token: VersionToken = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
    expect(Object.values(token).every((value) => typeof value === 'bigint')).toBe(true);
  });
});
