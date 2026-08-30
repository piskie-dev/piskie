import {
  ResourceLedger,
  type ResourceCloseResult,
  type ResourceDefinition,
  type ResourceHandle,
  type ResourceSnapshot,
} from './resource-ledger.js';

export class ResourceScope {
  private readonly handles: ResourceHandle[] = [];
  private readonly children: ResourceScope[] = [];
  private readonly controller = new AbortController();
  private closePromise?: Promise<readonly ResourceCloseResult[]>;

  readonly signal = this.controller.signal;

  constructor(
    readonly generation: string,
    readonly owner: string,
    private readonly ledger: ResourceLedger,
    parentSignal?: AbortSignal,
  ) {
    if (parentSignal?.aborted) {
      this.controller.abort(parentSignal.reason);
    } else {
      parentSignal?.addEventListener(
        'abort',
        () => this.controller.abort(parentSignal.reason),
        { once: true },
      );
    }
  }

  register(definition: ResourceDefinition): ResourceHandle {
    if (this.signal.aborted || this.closePromise) {
      throw new Error(`Resource scope ${this.owner} is closed`);
    }
    const handle = this.ledger.register(this.owner, definition);
    this.handles.push(handle);
    return handle;
  }

  child(name: string): ResourceScope {
    if (this.signal.aborted || this.closePromise) {
      throw new Error(`Resource scope ${this.owner} is closed`);
    }
    const scope = new ResourceScope(
      this.generation,
      `${this.owner}/${name}`,
      this.ledger,
      this.signal,
    );
    this.children.push(scope);
    return scope;
  }

  close(reason: string, timeoutMs = 5_000): Promise<readonly ResourceCloseResult[]> {
    if (this.closePromise) return this.closePromise;
    this.controller.abort(reason);
    this.closePromise = this.closeNow(reason, timeoutMs);
    return this.closePromise;
  }

  async residuals(): Promise<readonly ResourceSnapshot[]> {
    return this.ledger.snapshots(this.resourceIds());
  }

  private resourceIds(): string[] {
    return [
      ...this.handles.map((handle) => handle.id),
      ...this.children.flatMap((child) => child.resourceIds()),
    ];
  }

  private async closeNow(
    reason: string,
    timeoutMs: number,
  ): Promise<readonly ResourceCloseResult[]> {
    const results: ResourceCloseResult[] = [];
    for (const child of [...this.children].reverse()) {
      results.push(...await child.close(reason, timeoutMs));
    }
    results.push(...await this.ledger.closeMany(
      this.handles.map((handle) => handle.id),
      reason,
      timeoutMs,
    ));
    return results;
  }
}
