import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInputRequest } from '../../../../shared/types/index.js';
import type { BackgroundJob } from '../../types.js';
import { BackgroundRegistry } from '../background-registry.js';

type Exit = Awaited<ReturnType<BackgroundJob['exited']>>;

class FakeJob implements BackgroundJob {
  readonly kill = vi.fn(async () => {
    this.finish({ status: 'killed', durationMs: 1, tail: '', outputTruncated: false });
  });

  private readonly completion: Promise<Exit>;
  private resolve!: (outcome: Exit) => void;
  private reject!: (error: unknown) => void;

  constructor(readonly outFile: string, readonly description?: string) {
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
    const job = new FakeJob(path.join(tempDir, '12345678.log'), 'Sample check');

    const offer = host.offer(job);
    expect(registry.promote('call-1')).toBe(true);
    expect(registry.promote('call-1')).toBe(false);
    await expect(offer.promoted).resolves.toBe('user');

    const handle = host.adopt(job, 'user');
    expect(handle).toEqual({ id: '12345678', outFile: job.outFile });
    expect(registry.activeTaskIds()).toEqual(['12345678']);
    expect(registry.promote('call-1')).toBe(false);

    job.finish({ status: 'ok', exitCode: 0, durationMs: 12, tail: 'done', outputTruncated: false });
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith({
      source: 'system',
      priority: 'normal',
      content: {
        kind: 'background_task_done',
        taskId: '12345678',
        status: 'ok',
        summary: '后台任务「Sample check」完成，用时 12ms。',
        tail: 'done',
        outputTruncated: false,
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

  it.each([false, true])('persists output completeness (%s) when Mailbox ingress rejects the event', async (outputTruncated) => {
    const warning = vi.fn();
    const registry = new BackgroundRegistry({ onWarning: warning });
    const host = registry.forCall('call-3', () => false);
    const job = new FakeJob(path.join(tempDir, 'abcdefgh.log'));
    const handle = host.adopt(job, 'declared');

    job.finish({ status: 'failed', exitCode: 2, durationMs: 8, tail: 'bad', outputTruncated });
    const recordPath = path.join(tempDir, `${handle.id}.done.json`);
    await vi.waitFor(async () => {
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      expect(record).toEqual({
        kind: 'background_task_done',
        taskId: handle.id,
        status: 'failed',
        summary: '后台任务失败（exit 2），用时 8ms。',
        tail: 'bad',
        outputTruncated,
        ...(outputTruncated ? { outputFile: job.outFile } : {}),
      });
    });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(`persisted to ${recordPath}`),
    );
  });

  it('keeps descriptions paired with task ids when silent jobs finish out of order', async () => {
    const registry = new BackgroundRegistry();
    const events: AgentInputRequest[] = [];
    const post = (event: AgentInputRequest): boolean => { events.push(event); return true; };
    const first = new FakeJob(path.join(tempDir, 'sample-first.log'), 'First sample check');
    const second = new FakeJob(path.join(tempDir, 'sample-second.log'), 'Second sample check');
    const firstHandle = registry.forCall('first-call', post).adopt(first, 'declared');
    const secondHandle = registry.forCall('second-call', post).adopt(second, 'declared');

    second.finish({ status: 'killed', durationMs: 3, tail: '', outputTruncated: false });
    first.finish({ status: 'ok', exitCode: 0, durationMs: 4, tail: '', outputTruncated: false });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events.map((event) => event.content)).toEqual([
      {
        kind: 'background_task_done', taskId: secondHandle.id, status: 'killed',
        summary: '后台任务「Second sample check」已终止，用时 3ms。', tail: '', outputTruncated: false,
      },
      {
        kind: 'background_task_done', taskId: firstHandle.id, status: 'ok',
        summary: '后台任务「First sample check」完成，用时 4ms。', tail: '', outputTruncated: false,
      },
    ]);
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
