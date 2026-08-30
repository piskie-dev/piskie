import { appLog } from '@electron/observability/logging/app-log.js';
import type { RawCall, ToolResult } from '../types.js';

export interface ToolExecutionInterval {
  startedAt: number;
  finishedAt: number;
}

export type ToolObservation = Readonly<{
  raw: RawCall;
  effectiveName?: string;
  intervals: ToolExecutionInterval[];
  outcome: 'ok' | 'error' | 'rejected' | 'suspended' | 'invariant';
  result?: ToolResult;
  data?: unknown;
  error?: unknown;
}>;

export interface ToolObserver {
  start(raw: RawCall): void;
  executionStarted?(raw: RawCall, startedAt: number): void;
  executionFinished?(raw: RawCall, interval: ToolExecutionInterval): void;
  finish(observation: ToolObservation): void;
}

export const loggingToolObserver: ToolObserver = {
  start(_raw) {},
  finish(_observation) {},
};

export async function observe<T>(
  raw: RawCall,
  observer: ToolObserver,
  run: () => Promise<T>,
  describe: (
    value: T
  ) => Pick<ToolObservation, 'effectiveName' | 'outcome' | 'result' | 'data' | 'intervals'>
): Promise<T> {
  safelyNotifyToolObserver(raw, 'start', () => observer.start(raw));
  try {
    const value = await run();
    safelyNotifyToolObserver(raw, 'finish', () => observer.finish({ raw, ...describe(value) }));
    return value;
  } catch (error) {
    safelyNotifyToolObserver(raw, 'finish', () =>
      observer.finish({
        raw,
        intervals: [],
        outcome: 'invariant',
        error,
      })
    );
    throw error;
  }
}

export function safelyNotifyToolObserver(
  raw: RawCall,
  stage: 'start' | 'execution-started' | 'execution-finished' | 'finish',
  notify: () => void
): void {
  try {
    notify();
  } catch (error) {
    appLog.warn({
      event: 'tool.observer.notify.degraded',
      message: 'Tool observer notification degraded',
      context: { scope: 'tool.observer', callId: raw.callId, stage },
      error,
    });
  }
}
