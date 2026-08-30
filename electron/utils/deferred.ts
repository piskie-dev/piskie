/**
 * createDeferred — 可外部 settle 的 Promise。
 * 用于"门闩必须先于任何可能执行用户代码的操作安装"的场景：
 * 先占位 Promise，再执行可能同步重入的回调（如 abort listeners），重入方拿到同一个门闩。
 */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
