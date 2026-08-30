import { createUuid } from '@shared/utils/identifiers.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  BackgroundHandle,
  BackgroundHost,
  BackgroundHostFactory,
  BackgroundJob,
} from '../types.js';
import type { AgentInputRequest } from '../../../shared/types/index.js';

type Offer = {
  callId: string;
  job: BackgroundJob;
  promoted: boolean;
  resolve: (value: 'user') => void;
  promise: Promise<'user'>;
};

type Lease = Readonly<{
  id: string;
  job: BackgroundJob;
  post: (event: AgentInputRequest) => boolean;
}>;

export type BackgroundRegistryOptions = Readonly<{
  onWarning?: (message: string, error?: unknown) => void;
  onChange?: () => void;
}>;

/** Per-agent owner for both promotable calls and adopted background jobs. */
export class BackgroundRegistry implements BackgroundHostFactory {
  private readonly offers = new Map<string, Offer>();
  private readonly leases = new Map<string, Lease>();

  constructor(private readonly options: BackgroundRegistryOptions = {}) {}

  forCall(
    callId: string,
    post: (event: AgentInputRequest) => boolean,
  ): BackgroundHost {
    return {
      offer: (job) => this.offer(callId, job),
      adopt: (job, reason) => this.adopt(callId, job, reason, post),
    };
  }

  promote(callId: string): boolean {
    const offer = this.offers.get(callId);
    if (!offer || offer.promoted) return false;
    offer.promoted = true;
    offer.resolve('user');
    return true;
  }

  activeTaskIds(): readonly string[] {
    return Object.freeze([...this.leases.keys()]);
  }

  hasActiveJobs(): boolean {
    return this.leases.size > 0;
  }

  async dispose(): Promise<void> {
    const jobs = new Set<BackgroundJob>();
    for (const offer of this.offers.values()) jobs.add(offer.job);
    for (const lease of this.leases.values()) jobs.add(lease.job);
    this.offers.clear();
    this.leases.clear();
    this.options.onChange?.();
    await Promise.allSettled([...jobs].map((job) => job.kill()));
    await Promise.allSettled([...jobs].map((job) => job.exited()));
  }

  private offer(
    callId: string,
    job: BackgroundJob,
  ): { promoted: Promise<'user'>; withdraw(): void } {
    if (this.offers.has(callId)) throw new Error(`Background offer already exists: ${callId}`);
    let resolve!: (value: 'user') => void;
    const promise = new Promise<'user'>((done) => { resolve = done; });
    const offer: Offer = { callId, job, promoted: false, resolve, promise };
    this.offers.set(callId, offer);
    this.options.onChange?.();
    return {
      promoted: promise,
      withdraw: () => {
        if (this.offers.get(callId) !== offer) return;
        this.offers.delete(callId);
        this.options.onChange?.();
      },
    };
  }

  private adopt(
    callId: string,
    job: BackgroundJob,
    _reason: 'declared' | 'timeout' | 'user',
    post: (event: AgentInputRequest) => boolean,
  ): BackgroundHandle {
    if ([...this.leases.values()].some((lease) => lease.job === job)) {
      throw new Error('Background job was adopted more than once');
    }
    const offer = this.offers.get(callId);
    if (offer?.job === job) this.offers.delete(callId);

    const id = uniqueTaskId(job.outFile, this.leases);
    const lease: Lease = { id, job, post };
    this.leases.set(id, lease);
    this.options.onChange?.();
    void this.watch(lease);
    return Object.freeze({ id, outFile: job.outFile });
  }

  private async watch(lease: Lease): Promise<void> {
    let outcome: Awaited<ReturnType<BackgroundJob['exited']>>;
    try {
      outcome = await lease.job.exited();
    } catch (error) {
      if (this.leases.get(lease.id) === lease) {
        this.leases.delete(lease.id);
        this.options.onChange?.();
      }
      this.options.onWarning?.(`Background job completion failed for ${lease.id}`, error);
      return;
    }
    if (this.leases.get(lease.id) !== lease) return;
    this.leases.delete(lease.id);
    this.options.onChange?.();

    const summary = outcome.status === 'ok'
      ? `后台任务完成，用时 ${outcome.durationMs}ms。`
      : outcome.status === 'killed'
        ? `后台任务已终止，用时 ${outcome.durationMs}ms。`
        : `后台任务失败${outcome.exitCode === undefined ? '' : `（exit ${outcome.exitCode}）`}，用时 ${outcome.durationMs}ms。`;
    const content = {
      kind: 'background_task_done',
      taskId: lease.id,
      outputFile: lease.job.outFile,
      status: outcome.status,
      summary,
      tail: outcome.tail,
    };
    let delivered = false;
    try {
      delivered = lease.post({ source: 'system', priority: 'normal', content });
    } catch (error) {
      this.options.onWarning?.(`Background completion post threw for ${lease.id}`, error);
    }
    if (delivered) return;

    const recordPath = path.join(path.dirname(lease.job.outFile), `${lease.id}.done.json`);
    try {
      await fs.writeFile(recordPath, JSON.stringify(content, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      this.options.onWarning?.(`Failed to persist background completion ${lease.id}`, error);
      return;
    }
    this.options.onWarning?.(
      `Background completion ${lease.id} was not delivered; persisted to ${recordPath}`,
    );
  }
}

function uniqueTaskId(outFile: string, leases: ReadonlyMap<string, Lease>): string {
  const candidate = path.basename(outFile, path.extname(outFile));
  if (/^[a-zA-Z0-9_-]{8,}$/u.test(candidate) && !leases.has(candidate)) return candidate;
  let id = createUuid();
  while (leases.has(id)) id = createUuid();
  return id;
}
