/**
 * Mutex 互斥锁实现
 * 用于保证异步操作的串行化
 */

interface MutexGuard {
  dispose(): void;
}

type MutexWaiter = {
  readonly signal?: AbortSignal;
  readonly resolve: (guard: MutexGuard) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onAbort?: () => void;
};

/**
 * 互斥锁
 * 确保同一时刻只有一个操作在执行
 */
export class Mutex {
  private queue: MutexWaiter[] = [];
  private locked = false;

  /**
   * 获取锁
   * 如果锁已被占用，则等待
   */
  acquire(signal?: AbortSignal): Promise<MutexGuard> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise<MutexGuard>((resolve, reject) => {
      if (!this.locked) {
        this.locked = true;
        resolve(this.createGuard());
        return;
      }

      const waiter: MutexWaiter = {
        signal,
        resolve,
        reject,
        onAbort: signal
          ? () => {
              const index = this.queue.indexOf(waiter);
              if (index === -1) return;
              this.queue.splice(index, 1);
              reject(abortReason(signal));
            }
          : undefined,
      };
      this.queue.push(waiter);
      signal?.addEventListener('abort', waiter.onAbort!, { once: true });
    });
  }

  private createGuard(): MutexGuard {
    let released = false;
    return {
      dispose: () => {
        if (released) return;
        released = true;
        this.releaseNext();
      },
    };
  }

  private releaseNext(): void {
    for (;;) {
      const waiter = this.queue.shift();
      if (!waiter) {
        this.locked = false;
        return;
      }
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      if (waiter.signal?.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      waiter.resolve(this.createGuard());
      return;
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('Mutex acquisition was cancelled');
  error.name = 'AbortError';
  return error;
}
