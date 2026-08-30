export class ShutdownCoordinator<Result> {
  private pending?: Promise<Result>;
  private firstReason?: string;

  request(reason: string, shutdown: (firstReason: string) => Promise<Result>): Promise<Result> {
    if (this.pending) return this.pending;
    this.firstReason = reason;
    this.pending = Promise.resolve().then(() => shutdown(this.firstReason!));
    return this.pending;
  }

  get reason(): string | undefined {
    return this.firstReason;
  }
}
