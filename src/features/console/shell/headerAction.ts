import type { AgentTarget } from '../../../../shared/types/agent-control';

export type ConsoleHeaderAction =
  | { kind: 'approval'; requestId: number }
  | { kind: 'error'; requestId: number; target: AgentTarget }
  | { kind: 'newChat'; requestId: number };

export type ConsoleHeaderActionInput =
  | { kind: 'approval' }
  | { kind: 'error'; target: AgentTarget }
  | { kind: 'newChat' };

let lastRequestId = 0;

export function createConsoleHeaderAction(input: ConsoleHeaderActionInput): ConsoleHeaderAction {
  lastRequestId = Math.max(Date.now(), lastRequestId + 1);
  return { ...input, requestId: lastRequestId } as ConsoleHeaderAction;
}
