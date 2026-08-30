/**
 * 上游：openclaw src/channels/logging.ts（MIT）
 * 消费方：feishu vendor card/reply-dispatcher.js（typing 失败日志）
 */

export type LogFn = (message: string) => void;

export function logTypingFailure(params: {
  log: LogFn;
  channel: string;
  target?: string;
  action?: 'start' | 'stop';
  error: unknown;
}): void {
  const target = params.target ? ` target=${params.target}` : '';
  const action = params.action ? ` action=${params.action}` : '';
  params.log(`${params.channel} typing${action} failed${target}: ${String(params.error)}`);
}
