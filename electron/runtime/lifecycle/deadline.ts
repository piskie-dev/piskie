export type DeadlineResult<T> =
  | { outcome: 'settled'; value: T; durationMs: number }
  | { outcome: 'failed'; error: unknown; durationMs: number }
  | { outcome: 'timed-out'; durationMs: number };

export async function settleWithDeadline<T>(
  task: () => Promise<T> | T,
  timeoutMs: number,
): Promise<DeadlineResult<T>> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const operation = Promise.resolve().then(task);
  operation.catch(() => undefined);

  const timeout = new Promise<symbol>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    timer.unref?.();
  });

  const result = await Promise.race([operation, timeout]).then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error) => ({ status: 'rejected' as const, error }),
  );
  if (timer) clearTimeout(timer);

  const durationMs = Date.now() - startedAt;
  if (result.status === 'rejected') {
    return { outcome: 'failed', error: result.error, durationMs };
  }
  if (result.value === TIMEOUT) {
    return { outcome: 'timed-out', durationMs };
  }
  return { outcome: 'settled', value: result.value as T, durationMs };
}

const TIMEOUT = Symbol('deadline-timeout');
