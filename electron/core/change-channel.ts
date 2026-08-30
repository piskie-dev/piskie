export type ChangeListener<T> = (change: T) => void;
export type Unsubscribe = () => void;

export interface ChangeSource<T> {
  subscribe(
    listener: ChangeListener<T>,
    options?: { signal?: AbortSignal },
  ): Unsubscribe;
}

export interface ChangeSink<T> {
  publish(change: T): void;
}

export interface ChangeChannel<T> {
  source: ChangeSource<T>;
  sink: ChangeSink<T>;
}

export interface ChangeChannelOptions<T> {
  onSubscriberError?: (error: unknown, change: T) => void;
}

const NOOP: Unsubscribe = () => undefined;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}

export function createChangeChannel<T>(
  options: ChangeChannelOptions<T> = {},
): ChangeChannel<T> {
  const listeners = new Set<ChangeListener<T>>();

  const reportSubscriberError = (error: unknown, change: T): void => {
    try {
      options.onSubscriberError?.(error, change);
    } catch {
      // Diagnostics must not turn an observed fact into a domain failure.
    }
  };

  const source: ChangeSource<T> = Object.freeze({
    subscribe(
      listener: ChangeListener<T>,
      subscribeOptions: { signal?: AbortSignal } = {},
    ): Unsubscribe {
      const { signal } = subscribeOptions;
      if (signal?.aborted) return NOOP;

      let active = true;
      const unsubscribe = (): void => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        signal?.removeEventListener('abort', unsubscribe);
      };

      listeners.add(listener);
      signal?.addEventListener('abort', unsubscribe, { once: true });
      return unsubscribe;
    },
  });

  const sink: ChangeSink<T> = Object.freeze({
    publish(change: T): void {
      for (const listener of [...listeners]) {
        try {
          const result = listener(change) as unknown;
          if (isPromiseLike(result)) {
            void Promise.resolve(result).catch((error) => reportSubscriberError(error, change));
          }
        } catch (error) {
          reportSubscriberError(error, change);
        }
      }
    },
  });

  return Object.freeze({ source, sink });
}
