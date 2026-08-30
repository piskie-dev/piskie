import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundJob } from '../../types.js';
import { BackgroundRegistry } from '../background-registry.js';

type Exit = Awaited<ReturnType<BackgroundJob['exited']>>;

class FakeJob implements BackgroundJob {
  readonly kill = vi.fn(async () => {
    this.finish({ status: 'killed', durationMs: 1, tail: '' });
  });

  private readonly completion: Promise<Exit>;
  private resolve!: (outcome: Exit) => void;
  private reject!: (error: unknown) => void;

  constructor(readonly outFile: string) {
    this.completion = new Promise<Exit>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  exited(): Promise<Exit> {
    return this.completion;
  }

  finish(outcome: Exit): void {
    this.resolve(outcome);
  }

  fail(error: unknown): void {
    this.reject(error);
  }
}

describe('BackgroundRegistry', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-background-registry-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('offers, promotes, and adopts one job through the same per-call lifecycle', async () => {
    const post = vi.fn(() => true);
    const registry = new BackgroundRegistry();
    const host = registry.forCall('call-1', post);
    const job = new FakeJob(path.join(tempDir, '12345678.log'));

    const offer = host.offer(job);
    expect(registry.promote('call-1')).toBe(true);
    expect(registry.promote('call-1')).toBe(false);
    await expect(offer.promoted).resolves.toBe('user');

    const handle = host.adopt(job, 'user');
    expect(handle).toEqual({ id: '12345678', outFile: job.outFile });
    expect(registry.activeTaskIds()).toEqual(['12345678']);
    expect(registry.promote('call-1')).toBe(false);

    job.finish({ status: 'ok', exitCode: 0, durationMs: 12, tail: 'done' });
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith({
      source: 'system',
      priority: 'normal',
      content: {
        kind: 'background_task_done',
        taskId: '12345678',
        outputFile: job.outFile,
        status: 'ok',
        summary: '后台任务完成，用时 12ms。',
        tail: 'done',
      },
    });
    expect(registry.hasActiveJobs()).toBe(false);
  });

  it('withdraws an offer when the foreground job finishes first', () => {
    const registry = new BackgroundRegistry();
    const host = registry.forCall('call-2', () => true);
    const job = new FakeJob(path.join(tempDir, 'foreground.log'));

    const offer = host.offer(job);
    offer.withdraw();
    offer.withdraw();

    expect(registry.promote('call-2')).toBe(false);
    expect(registry.hasActiveJobs()).toBe(false);
  });

  it('persists a completion record when Mailbox ingress rejects the event', async () => {
    const warning = vi.fn();
    const registry = new BackgroundRegistry({ onWarning: warning });
    const host = registry.forCall('call-3', () => false);
    const job = new FakeJob(path.join(tempDir, 'abcdefgh.log'));
    const handle = host.adopt(job, 'declared');

    job.finish({ status: 'failed', exitCode: 2, durationMs: 8, tail: 'bad' });
    const recordPath = path.join(tempDir, `${handle.id}.done.json`);
    await vi.waitFor(async () => {
      await expect(fs.readFile(recordPath, 'utf8')).resolves.toContain('background_task_done');
    });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(`persisted to ${recordPath}`),
    );
  });

  it('cleans rejected completion promises without leaving a live lease', async () => {
    const warning = vi.fn();
    const registry = new BackgroundRegistry({ onWarning: warning });
    const job = new FakeJob(path.join(tempDir, 'rejected.log'));
    registry.forCall('call-4', () => true).adopt(job, 'declared');

    job.fail(new Error('adapter failed'));
    await vi.waitFor(() => expect(registry.hasActiveJobs()).toBe(false));
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Background job completion failed'),
      expect.any(Error),
    );
  });

  it('disposes both foreground offers and adopted leases', async () => {
    const changes = vi.fn();
    const registry = new BackgroundRegistry({ onChange: changes });
    const offered = new FakeJob(path.join(tempDir, 'offered.log'));
    const adopted = new FakeJob(path.join(tempDir, 'adopted.log'));
    registry.forCall('call-5', () => true).offer(offered);
    registry.forCall('call-6', () => true).adopt(adopted, 'declared');

    await registry.dispose();

    expect(offered.kill).toHaveBeenCalledOnce();
    expect(adopted.kill).toHaveBeenCalledOnce();
    expect(registry.promote('call-5')).toBe(false);
    expect(registry.hasActiveJobs()).toBe(false);
    expect(changes).toHaveBeenCalled();
  });
});
