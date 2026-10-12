import type { TranscriptNode, UserNode, WorkerNode } from '@/domains/transcript/nodes';
import type { TranscriptResponse } from '@/domains/transcript/types';

export type ToolIntervalNode = Extract<TranscriptNode, { kind: 'tool' | 'plan' }>;

export interface ToolIntervalRow {
  readonly kind: 'tools';
  readonly id: string;
  readonly nodes: readonly TranscriptNode[];
  readonly latest: ToolIntervalNode;
  readonly workerCards?: readonly WorkerNode[];
}

export type TranscriptContentRow =
  | { readonly kind: 'node'; readonly id: string; readonly node: TranscriptNode; readonly workerCards?: readonly WorkerNode[] }
  | ToolIntervalRow;

export type TranscriptRow = TranscriptContentRow | {
  readonly kind: 'process';
  readonly id: string;
  readonly rows: readonly TranscriptContentRow[];
  /** Unique current dispatch references; historical creations remain in rows. */
  readonly workerCards: readonly WorkerNode[];
  readonly durationMs?: number;
  readonly observedDurationMs?: number;
  readonly workerProgress?: ProcessWorkerProgress;
};

/** Historical execution facts, independent of the current summary locations. */
export interface ProcessWorkerProgress {
  readonly unfinished: number;
  readonly failed: number;
  readonly stopped: number;
  readonly totalDurationMs?: number;
}

/** Retains each execution's fold position and observed normal completion between renders. */
export interface ProcessBoundary {
  /** Null records a normal direct reply with no preceding work to fold. */
  readonly endNodeId: string | null;
  readonly durationMs?: number;
  /** Anchors a completed response and the following execution, including direct replies. */
  readonly finalTextNodeId?: string;
}

/** A null boundary marks observed work without a fold or a normal final reply. */
export type TranscriptProcessBoundaries = ReadonlyMap<string, ProcessBoundary | null>;

function isTool(node: TranscriptNode): node is ToolIntervalNode {
  return node.kind === 'tool' || node.kind === 'plan';
}

export function isPendingTranscriptNode(node: TranscriptNode): boolean {
  return (node.kind === 'tool' && node.state.phase === 'awaiting-approval')
    || (node.kind === 'plan' && node.pendingCallId !== undefined);
}

const nodeRow = (node: TranscriptNode): TranscriptContentRow => ({ kind: 'node', id: node.id, node });

/** Text output and inline worker cards delimit tool intervals across assistant requests. */
export function groupToolIntervals(nodes: readonly TranscriptNode[]): TranscriptContentRow[] {
  const rows: TranscriptContentRow[] = [];
  let interval: TranscriptNode[] = [];
  const flush = () => {
    const first = interval.findIndex(isTool);
    let last = interval.length - 1;
    while (last >= 0 && !isTool(interval[last]!)) last -= 1;
    if (first < 0 || first === last) {
      rows.push(...interval.map(nodeRow));
    } else {
      rows.push(...interval.slice(0, first).map(nodeRow));
      rows.push({
        kind: 'tools',
        id: `tools:${interval[first]!.id}`,
        nodes: interval.slice(first, last + 1),
        latest: interval[last] as ToolIntervalNode,
      });
      rows.push(...interval.slice(last + 1).map(nodeRow));
    }
    interval = [];
  };
  for (const node of nodes) {
    if (node.kind === 'assistant' || node.kind === 'user' || node.kind === 'worker') {
      flush();
      rows.push(nodeRow(node));
    } else {
      interval.push(node);
    }
  }
  flush();
  return rows;
}

/** Both timestamps come from existing message records; missing history has no invented duration. */
function durationBetween(start: number | undefined, end: number): number | undefined {
  return start !== undefined && Number.isFinite(start) && start > 0
    && Number.isFinite(end) && end >= start
    ? end - start
    : undefined;
}

type WorkerAction =
  | { readonly kind: 'sent'; readonly index: number; readonly turnId?: string }
  | { readonly kind: 'terminal'; readonly index: number; readonly eventType: 'completed' | 'failed' | 'user_stopped'; readonly at: number };

function workerActivity(nodes: readonly TranscriptNode[]): {
  readonly positions: ReadonlyMap<string, number>;
  readonly actions: ReadonlyMap<string, readonly WorkerAction[]>;
  readonly creations: ReadonlyMap<string, WorkerNode>;
  readonly assignedNode: ReadonlyMap<string, string>;
} {
  const positions = new Map<string, number>();
  const actions = new Map<string, WorkerAction[]>();
  const creations = new Map<string, WorkerNode>();
  const assignedNode = new Map<string, string>();
  let turnId: string | undefined;
  const add = (id: string, action: WorkerAction) => {
    const timeline = actions.get(id) ?? [];
    timeline.push(action);
    actions.set(id, timeline);
  };
  nodes.forEach((node, index) => {
    if (node.kind === 'user' && node.origin === 'user') turnId = node.id;
    if (node.kind === 'worker' && node.workerId) {
      positions.set(node.id, index);
      creations.set(node.workerId, node);
      assignedNode.set(node.workerId, node.id);
    }
    if (node.kind === 'tool' && node.state.phase === 'ok' && node.workerMessage?.targetId) {
      add(node.workerMessage.targetId, { kind: 'sent', index, turnId });
      assignedNode.set(node.workerMessage.targetId, node.id);
    }
    if (node.kind === 'notice' && node.source && (
      node.eventType === 'completed' || node.eventType === 'failed' || node.eventType === 'user_stopped'
    )) {
      add(node.source, { kind: 'terminal', index, eventType: node.eventType, at: node.eventAt ?? node.ts });
    }
  });
  return { positions, actions, creations, assignedNode };
}

function rowWorkerCards(nodes: readonly TranscriptNode[], activity: ReturnType<typeof workerActivity>): WorkerNode[] {
  return nodes.flatMap((node) => {
    const workerId = node.kind === 'worker' ? node.workerId
      : node.kind === 'tool' && node.state.phase === 'ok' ? node.workerMessage?.targetId : undefined;
    if (!workerId || activity.assignedNode.get(workerId) !== node.id) return [];
    const creation = activity.creations.get(workerId);
    return creation ? [creation] : [];
  });
}

function assignContentWorkerCards(row: TranscriptContentRow, activity: ReturnType<typeof workerActivity>): TranscriptContentRow {
  const workerCards = rowWorkerCards(row.kind === 'node' ? [row.node] : row.nodes, activity);
  return workerCards.length > 0 ? { ...row, workerCards } : row;
}

/** Ownership follows the last successful dispatch's actual row, across stable process boundaries. */
function assignWorkerCards(row: TranscriptRow, activity: ReturnType<typeof workerActivity>): TranscriptRow {
  if (row.kind !== 'process') return assignContentWorkerCards(row, activity);
  const rows = row.rows.map((child) => assignContentWorkerCards(child, activity));
  return { ...row, rows, workerCards: rows.flatMap((child) => child.workerCards ?? []) };
}

function processWorkerProgress(
  folded: readonly TranscriptNode[],
  turnId: string | undefined,
  start: number | undefined,
  mainDurationMs: number | undefined,
  canFinish: boolean,
  activity: ReturnType<typeof workerActivity>,
): ProcessWorkerProgress | undefined {
  const workers = folded.filter((node): node is Extract<TranscriptNode, { kind: 'worker' }> => (
    node.kind === 'worker' && !!node.workerId
  ));
  if (workers.length === 0) return undefined;

  let unfinished = 0;
  let failed = 0;
  let stopped = 0;
  let lastEnd = start !== undefined && mainDurationMs !== undefined ? start + mainDurationMs : undefined;
  for (const worker of workers) {
    let terminal: Extract<WorkerAction, { kind: 'terminal' }> | undefined;
    for (const action of activity.actions.get(worker.workerId) ?? []) {
      if (action.index <= (activity.positions.get(worker.id) ?? -1)) continue;
      if (action.kind === 'sent') {
        // A later user turn can give the same worker a new task; it does not reopen this turn.
        if (action.turnId !== turnId) break;
        terminal = undefined;
      } else if (!terminal) {
        terminal = action;
      }
    }
    if (!terminal) {
      unfinished += 1;
    } else {
      if (terminal.eventType === 'failed') failed += 1;
      if (terminal.eventType === 'user_stopped') stopped += 1;
      lastEnd = Math.max(lastEnd ?? terminal.at, terminal.at);
    }
  }
  const totalDurationMs = unfinished === 0 && canFinish && lastEnd !== undefined
    ? durationBetween(start, lastEnd)
    : undefined;
  return {
    unfinished, failed, stopped,
    ...(totalDurationMs !== undefined && { totalDurationMs }),
  };
}

export function buildTranscriptRows(
  nodes: readonly TranscriptNode[],
  responses: readonly TranscriptResponse[],
  settled: boolean,
  previousBoundaries: TranscriptProcessBoundaries = new Map(),
): { readonly rows: TranscriptRow[]; readonly boundaries: TranscriptProcessBoundaries } {
  const responsesByUser = new Map<string | undefined, TranscriptResponse[]>();
  for (const response of responses) {
    const userResponses = responsesByUser.get(response.afterUserId) ?? [];
    userResponses.push(response);
    responsesByUser.set(response.afterUserId, userResponses);
  }
  const rows: TranscriptRow[] = [];
  const boundaries = new Map<string, ProcessBoundary | null>();
  const activity = workerActivity(nodes);
  let user: UserNode | undefined;
  let segment: TranscriptNode[] = [];

  const flush = (nextUser?: UserNode) => {
    const current = nextUser === undefined;
    const segmentId = user?.id ?? segment[0]?.id;
    if (segmentId === undefined) return;
    const userResponses = responsesByUser.get(user?.id) ?? [];
    let groupId = `process:${segmentId}`;
    let offset = 0;
    let afterSourceIndex = -1;
    let startedAt = user?.ts;
    let observedCompletion = false;

    do {
      const part = segment.slice(offset);
      const partResponses = userResponses.filter((response) => response.sourceIndex > afterSourceIndex);
      const previous = previousBoundaries.get(groupId);
      let boundary = previous ?? null;
      let collapseAt = previous?.endNodeId ? part.findIndex((node) => node.id === previous.endNodeId) + 1 : 0;
      if (previous?.finalTextNodeId !== undefined) {
        observedCompletion = true;
        const response = partResponses.find((candidate) => candidate.textNodeIds.includes(previous.finalTextNodeId!));
        boundary = {
          ...previous,
          durationMs: response ? durationBetween(startedAt, response.ts) ?? previous.durationMs : previous.durationMs,
        };
      } else {
        // A persisted no-tool reply ends runTurn. A later subagent event lets history
        // recover that completion even if the UI never observed the intervening idle state.
        const beforeNotice = part.filter((node) => node.kind === 'notice' && node.eventType !== undefined)
          .map((notice) => partResponses.filter((response) => response.sourceIndex < notice.sourceIndex).at(-1))
          .find((response) => response !== undefined && !response.hasToolUse && response.textNodeIds.length > 0);
        const response = beforeNotice ?? partResponses.at(-1);
        const finalIndex = part.findIndex((node) => response?.textNodeIds.includes(node.id));
        const completionEnd = finalIndex < 0 ? part.length
          : part.findIndex((node, index) => index > finalIndex && node.sourceIndex !== response!.sourceIndex);
        // Awaiting-commit live text and pending decisions remain visible. Later active
        // work does not prevent recovering an earlier reply before a notification.
        const confirmationNodes = beforeNotice && completionEnd >= 0 ? part.slice(0, completionEnd) : part;
        const canConfirm = (beforeNotice !== undefined || (current ? settled : !previousBoundaries.has(groupId)))
          && !confirmationNodes.some((node) => node.sourceIndex === -1 || isPendingTranscriptNode(node));
        if (canConfirm && !response?.hasToolUse) {
          if (finalIndex >= collapseAt && finalIndex >= 0) {
            collapseAt = finalIndex;
            boundary = {
              endNodeId: part[finalIndex - 1]?.id ?? null,
              durationMs: durationBetween(startedAt, response!.ts) ?? boundary?.durationMs,
              finalTextNodeId: part[finalIndex]!.id,
            };
          } else if (finalIndex < 0 && !boundary && offset === 0 && part.length > 0) {
            // A partial history page can expose work without an identifiable final reply.
            collapseAt = part.length;
            boundary = { endNodeId: part.at(-1)!.id };
          }
        }
        // Only the unfinished execution folds at new input. A notification alone
        // leaves the preceding reply and the notification visible.
        if (boundary?.finalTextNodeId === undefined && (previous === null || (offset > 0 && observedCompletion))
          && (offset === 0 || partResponses.length > 0) && nextUser?.origin === 'user'
          && !previousBoundaries.has(`process:${nextUser.id}`) && part.length > 0) {
          collapseAt = part.length;
          boundary = { endNodeId: part.at(-1)!.id };
        }
      }
      boundaries.set(groupId, boundary);
      if (collapseAt > 0) {
        const folded = part.slice(0, collapseAt);
        // Without a final reply, stop at the last persisted activity, not the next user input.
        const lastActivityAt = folded.reduce(
          (latest, node) => node.sourceIndex >= 0 && Number.isFinite(node.ts) ? Math.max(latest, node.ts) : latest,
          0,
        );
        const observedDurationMs = boundary?.durationMs === undefined
          ? durationBetween(startedAt, lastActivityAt)
          : undefined;
        rows.push({
          kind: 'process',
          id: groupId,
          rows: groupToolIntervals(folded),
          workerCards: [],
          durationMs: boundary?.durationMs,
          observedDurationMs,
          workerProgress: processWorkerProgress(
            folded, user?.id, startedAt, boundary?.durationMs ?? observedDurationMs, !current || settled, activity,
          ),
        });
      }
      const finalIndex = part.findIndex((node) => node.id === boundary?.finalTextNodeId);
      if (finalIndex < 0) {
        rows.push(...groupToolIntervals(part.slice(collapseAt)));
        break;
      }
      // Keep the complete final response outside, then give subsequent work its own
      // stable group keyed by that reply, even when the reply itself needed no fold.
      afterSourceIndex = part[finalIndex]!.sourceIndex;
      const nextIndex = part.findIndex((node, index) => index > finalIndex && node.sourceIndex !== afterSourceIndex);
      const replyEnd = nextIndex < 0 ? part.length : nextIndex;
      rows.push(...groupToolIntervals(part.slice(collapseAt, replyEnd)));
      offset += replyEnd;
      groupId = `process:after:${boundary!.finalTextNodeId}`;
      const first = segment[offset];
      startedAt = first
        ? userResponses.find((response) => response.sourceIndex === first.sourceIndex)?.ts ?? first.ts
        : undefined;
    } while (offset < segment.length);
    segment = [];
  };

  for (const node of nodes) {
    if (node.kind === 'user') {
      flush(node);
      rows.push(nodeRow(node));
      user = node;
    } else {
      segment.push(node);
    }
  }
  flush();
  return { rows: rows.map((row) => assignWorkerCards(row, activity)), boundaries };
}
