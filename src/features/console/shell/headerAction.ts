import type { AgentTarget } from '../../../../shared/types/agent-control';

export type ConsoleHeaderAction =
  | { kind: 'approval'; requestId: number }
  | { kind: 'error'; requestId: number; target: AgentTarget }
  | { kind: 'reveal'; requestId: number; target: AgentTarget }
  | { kind: 'newChat'; requestId: number }
  | { kind: 'newTemplate'; requestId: number };

export type ConsoleHeaderActionInput =
  | { kind: 'approval' }
  | { kind: 'error'; target: AgentTarget }
  /** 其他页面（如定时任务的运行链接）点进来定位某个会话 */
  | { kind: 'reveal'; target: AgentTarget }
  | { kind: 'newChat' }
  | { kind: 'newTemplate' };

let lastRequestId = 0;

export function createConsoleHeaderAction(input: ConsoleHeaderActionInput): ConsoleHeaderAction {
  lastRequestId = Math.max(Date.now(), lastRequestId + 1);
  return { ...input, requestId: lastRequestId } as ConsoleHeaderAction;
}
