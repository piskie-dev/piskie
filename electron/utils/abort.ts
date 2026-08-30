import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * abort 挂接唯一习语。
 *
 * 五性质：
 * 1. pre-aborted 时同步调用 fn——addEventListener 对已 aborted 的 signal 永不触发，
 *    漏掉此分支是"取消丢失、只剩 timeout 兜底"的经典来源（shell killTree 曾中招）
 * 2. listener 用 { once: true }
 * 3. 正常 settle 由调用方主动 dispose（消费返回值），不留悬挂 listener
 * 4. fn 接收 signal.reason（取消原因不丢失）
 * 5. fn throw 不从 abort 事件分发中逃逸（记录后吞掉——取消回调的异常没有消费者，
 *    逃逸即 uncaughtException 级事故）
 */
export function linkAbort(
  signal: AbortSignal | undefined,
  fn: (reason: unknown) => void
): () => void {
  if (!signal) return () => {};
  const invoke = () => {
    try {
      fn(signal.reason);
    } catch (error) {
      appLog.warn({
        event: 'desktop.abort.callback.degraded',
        message: 'Abort callback failed',
        context: { scope: 'desktop.abort' },
        error,
      });
    }
  };
  if (signal.aborted) {
    invoke();
    return () => {};
  }
  signal.addEventListener('abort', invoke, { once: true });
  return () => signal.removeEventListener('abort', invoke);
}
