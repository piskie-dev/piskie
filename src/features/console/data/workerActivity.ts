import type { TFunction } from 'i18next';
import type { ChildTaskState } from '@shared/types/agent-control';
import type { TranscriptNode } from '@/domains/transcript/nodes';
import type { WorkerRef, WorkerVM } from './vm';
import { hasVisibleTranscriptContent, transcriptNodeText } from './transcriptNodePresentation';

export type WorkerOutcome = 'completed' | 'failed' | 'user_stopped';
export interface WorkerActivity {
  readonly text: string;
  readonly outcome?: WorkerOutcome;
  readonly unfinished: boolean;
}

export function terminalOutcome(type?: string): WorkerOutcome | undefined {
  return type === 'completed' || type === 'failed' || type === 'user_stopped' ? type : undefined;
}

export function isWorkerUnfinished(worker: WorkerRef): boolean {
  return !terminalOutcome(worker.taskState?.notification?.type);
}

/** Parent notices are historical evidence; the current runtime assignment takes precedence. */
export function latestWorkerNotification(nodes: readonly TranscriptNode[], workerId: string): ChildTaskState['notification'] {
  let inputAt = -Infinity;
  for (const node of nodes) {
    if (node.kind === 'tool' && node.state.phase === 'ok' && node.workerMessage?.targetId === workerId) {
      inputAt = Math.max(inputAt, node.workerMessage.callTs);
    }
  }
  let notification: ChildTaskState['notification'];
  for (const node of nodes) {
    if (node.kind === 'notice' && node.source === workerId && (
      terminalOutcome(node.eventType) || node.eventType === 'need_user_action' || node.eventType === 'message'
    )) {
      const at = node.eventAt ?? node.ts;
      if (at <= inputAt) continue;
      const terminal = terminalOutcome(node.eventType);
      const displayedTerminal = terminalOutcome(notification?.type);
      if (displayedTerminal && !terminal) continue;
      if (!notification || (terminal && !displayedTerminal) || at >= notification.at) {
        notification = { type: node.eventType as NonNullable<ChildTaskState['notification']>['type'], at };
      }
    }
  }
  return notification;
}

export function resolveWorkerActivity(
  worker: WorkerVM | null,
  nodes: readonly TranscriptNode[],
  parentNodes: readonly TranscriptNode[],
  workerId: string,
  t: TFunction,
): WorkerActivity {
  const notification = worker?.taskState ? worker.taskState.notification : latestWorkerNotification(parentNodes, workerId);
  const outcome = terminalOutcome(notification?.type);
  const last = nodes.findLast(hasVisibleTranscriptContent);
  return {
    text: last ? transcriptNodeText(last, t) : '',
    ...(outcome && { outcome }),
    unfinished: !!worker && !outcome,
  };
}
