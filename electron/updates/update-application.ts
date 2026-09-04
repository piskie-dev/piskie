import type {
  PiskieUpdateStatus,
  UpdateDisabledReason,
  UpdateTarget,
} from '../../shared/electron-contracts/updates.js';
import { createChangeChannel, type ChangeSource } from '../core/change-channel.js';
import { appLog } from '../observability/logging/app-log.js';
import type { UpdateProvider, UpdateProviderEvent } from './update-provider.js';

const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const log = appLog.child({ scope: 'desktop.updates' });

export class UpdateApplication {
  readonly changes: ChangeSource<PiskieUpdateStatus>;

  private readonly channel = createChangeChannel<PiskieUpdateStatus>({
    onSubscriberError: (error) => log.warn({
      event: 'desktop.updates.subscriber.failed',
      message: 'Update status subscriber failed',
      error,
    }),
  });
  private readonly initialDelayMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private current: PiskieUpdateStatus;
  private target?: UpdateTarget;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribeProvider?: () => void;
  private checkPromise?: Promise<PiskieUpdateStatus>;
  private started = false;
  private disposed = false;

  constructor(private readonly options: {
    currentVersion: string;
    provider?: UpdateProvider;
    disabledReason?: UpdateDisabledReason;
    initialDelayMs?: number;
    intervalMs?: number;
    now?: () => number;
  }) {
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.changes = this.channel.source;
    this.current = options.provider
      ? this.makeStatus({ state: 'idle' })
      : this.makeStatus({
          state: 'disabled',
          reason: options.disabledReason ?? 'unsupported-platform',
        });
  }

  start(): void {
    if (this.started || this.disposed || !this.options.provider) return;
    this.started = true;
    this.unsubscribeProvider = this.options.provider.subscribe((event) => this.onProviderEvent(event));
    this.schedule(this.initialDelayMs);
  }

  status(): PiskieUpdateStatus {
    return this.current;
  }

  check(): Promise<PiskieUpdateStatus> {
    const provider = this.options.provider;
    if (!provider || this.disposed) return Promise.resolve(this.current);
    if (
      this.current.state === 'available'
      || this.current.state === 'downloading'
      || this.current.state === 'downloaded'
    ) {
      return Promise.resolve(this.current);
    }
    if (this.checkPromise) return this.checkPromise;

    this.setStatus(this.makeStatus({ state: 'checking' }));
    const pending = provider.checkForUpdates()
      .then(() => this.current)
      .catch((error: unknown) => {
        if (this.current.state !== 'error') this.reportError(error);
        return this.current;
      })
      .finally(() => {
        if (this.checkPromise === pending) this.checkPromise = undefined;
      });
    this.checkPromise = pending;
    return pending;
  }

  restartAndInstall(): boolean {
    const provider = this.options.provider;
    if (!provider || this.current.state !== 'downloaded') return false;
    try {
      log.info({
        event: 'desktop.updates.install.requested',
        message: 'User requested restart and update installation',
        context: { targetVersion: this.current.target.version },
      });
      provider.quitAndInstall();
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribeProvider?.();
    this.unsubscribeProvider = undefined;
  }

  private onProviderEvent(event: UpdateProviderEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'checking':
        this.setStatus(this.makeStatus({ state: 'checking' }));
        return;
      case 'not-available':
        this.target = undefined;
        this.setStatus(this.makeStatus({
          state: 'up-to-date',
          checkedAt: this.checkedAt(),
        }));
        return;
      case 'available':
        this.target = publicTarget(event.release);
        this.setStatus(this.makeStatus({ state: 'available', target: this.target }));
        return;
      case 'progress': {
        const target = this.target ?? Object.freeze({ version: this.options.currentVersion });
        const { progress } = event;
        this.setStatus(this.makeStatus({
          state: 'downloading',
          target,
          percent: Math.min(100, progress.percent),
        }));
        return;
      }
      case 'downloaded':
        this.target = publicTarget(event.release);
        this.setStatus(this.makeStatus({ state: 'downloaded', target: this.target }));
        return;
      case 'error':
        this.reportError(event.error);
        return;
    }
  }

  private reportError(error: unknown): void {
    const kind = classifyUpdateError(error);
    log.warn({
      event: 'desktop.updates.check.failed',
      message: 'Desktop update check failed',
      error,
      context: { kind },
    });
    this.setStatus(this.makeStatus({
      state: 'error',
      error: kind,
      checkedAt: this.checkedAt(),
      retryable: true,
    }));
  }

  private schedule(delayMs: number): void {
    if (this.disposed || !this.options.provider) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check().finally(() => this.schedule(this.intervalMs));
    }, delayMs);
    this.timer.unref?.();
  }

  private setStatus(status: PiskieUpdateStatus): void {
    this.current = status;
    this.channel.sink.publish(status);
  }

  private checkedAt(): string {
    return new Date(this.now()).toISOString();
  }

  private makeStatus<T extends Omit<PiskieUpdateStatus, 'currentVersion'>>(
    status: T,
  ): PiskieUpdateStatus {
    return Object.freeze({
      currentVersion: this.options.currentVersion,
      ...status,
    }) as PiskieUpdateStatus;
  }
}

function publicTarget(release: { version: string }): UpdateTarget {
  return Object.freeze({ version: release.version });
}

export function classifyUpdateError(error: unknown): 'no-release' | 'network' | 'generic' {
  const message = error instanceof Error ? error.message : String(error);
  if (/no published versions|no releases|latest[^\s]*(?:yml|json)|404\b/i.test(message)) {
    return 'no-release';
  }
  if (/ENOTFOUND|ECONN|ETIMEDOUT|ERR_(?:INTERNET|NETWORK)|network|offline|socket|fetch/i.test(message)) {
    return 'network';
  }
  return 'generic';
}
