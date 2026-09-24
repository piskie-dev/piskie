const INITIAL_DELAY_MS = 30_000;
const INTERVAL_MS = 2 * 60 * 60 * 1_000;

export class BackgroundUpdateScheduler {
  private readonly initialDelayMs: number;
  private readonly intervalMs: number;
  private applicationChecksEnabled: boolean;
  private timer?: ReturnType<typeof setTimeout>;
  private scheduledAt?: number;
  private inFlight?: Promise<void>;
  private nextDelayMs?: number;
  private started = false;
  private disposed = false;

  constructor(private readonly options: {
    checkApplication: () => Promise<unknown>;
    refreshCatalog: () => Promise<unknown>;
    applicationChecksEnabled: boolean;
    initialDelayMs?: number;
    intervalMs?: number;
  }) {
    this.applicationChecksEnabled = options.applicationChecksEnabled;
    this.initialDelayMs = options.initialDelayMs ?? INITIAL_DELAY_MS;
    this.intervalMs = options.intervalMs ?? INTERVAL_MS;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.schedule(this.initialDelayMs);
  }

  setApplicationChecksEnabled(enabled: boolean): void {
    if (this.applicationChecksEnabled === enabled) return;
    this.applicationChecksEnabled = enabled;
    if (!enabled || !this.started || this.disposed) return;
    if (this.inFlight) {
      this.nextDelayMs = this.initialDelayMs;
    } else {
      if (this.scheduledAt !== undefined && this.scheduledAt <= Date.now() + this.initialDelayMs) return;
      if (this.timer) clearTimeout(this.timer);
      this.schedule(this.initialDelayMs);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.scheduledAt = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.disposed) return;
    this.scheduledAt = Date.now() + delayMs;
    this.timer = setTimeout(() => this.run(), delayMs);
    this.timer.unref?.();
  }

  private run(): void {
    this.timer = undefined;
    this.scheduledAt = undefined;
    const checks = [Promise.resolve().then(() => this.options.refreshCatalog())];
    if (this.applicationChecksEnabled) {
      checks.push(Promise.resolve().then(() => this.options.checkApplication()));
    }
    this.inFlight = Promise.allSettled(checks).then(() => {
      this.inFlight = undefined;
      const delayMs = this.nextDelayMs ?? this.intervalMs;
      this.nextDelayMs = undefined;
      this.schedule(delayMs);
    });
  }
}
