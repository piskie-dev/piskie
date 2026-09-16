import type { TranscriptNode, UserNode } from '@/domains/transcript/nodes';
import type { TranscriptResponse } from '@/domains/transcript/types';

export type ToolIntervalNode = Extract<TranscriptNode, { kind: 'tool' | 'plan' }>;

export interface ToolIntervalRow {
  readonly kind: 'tools';
  readonly id: string;
  readonly nodes: readonly TranscriptNode[];
  readonly latest: ToolIntervalNode;
}

export type TranscriptContentRow =
  | { readonly kind: 'node'; readonly id: string; readonly node: TranscriptNode }
  | ToolIntervalRow;

export type TranscriptRow = TranscriptContentRow | {
  readonly kind: 'process';
  readonly id: string;
  readonly rows: readonly TranscriptContentRow[];
  readonly durationMs?: number;
};

/** Only fold positions and observed normal completion are retained between renders. */
interface ProcessBoundary {
  /** Null records a normal direct reply with no preceding work to fold. */
  readonly endNodeId: string | null;
  readonly durationMs?: number;
  /** Identifies the last normally completed response, even when there was no work to fold. */
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

export function buildTranscriptRows(
  nodes: readonly TranscriptNode[],
  responses: readonly TranscriptResponse[],
  settled: boolean,
  previousBoundaries: TranscriptProcessBoundaries = new Map(),
): { readonly rows: TranscriptRow[]; readonly boundaries: TranscriptProcessBoundaries } {
  const lastResponseByUser = new Map<string | undefined, TranscriptResponse>();
  for (const response of responses) lastResponseByUser.set(response.afterUserId, response);
  const rows: TranscriptRow[] = [];
  const boundaries = new Map<string, ProcessBoundary | null>();
  let user: UserNode | undefined;
  let segment: TranscriptNode[] = [];

  const flush = (nextUser?: UserNode) => {
    const current = nextUser === undefined;
    const segmentId = user?.id ?? segment[0]?.id;
    if (segmentId === undefined) return;
    const groupId = `process:${segmentId}`;
    const previous = previousBoundaries.get(groupId);
    let boundary = previous ?? null;
    let collapseAt = previous?.endNodeId ? segment.findIndex((node) => node.id === previous.endNodeId) + 1 : 0;
    const response = lastResponseByUser.get(user?.id);
    // Historical segments can be inferred on first sight. Elapsed time requires normal completion.
    // Awaiting-commit live text is no longer animated but is still incomplete.
    const canConfirm = (current ? settled : !previousBoundaries.has(groupId))
      && !segment.some((node) => node.sourceIndex === -1 || isPendingTranscriptNode(node));
    if (canConfirm && !response?.hasToolUse) {
      const finalTextIds = new Set(response?.textNodeIds);
      const finalIndex = segment.findIndex((node) => finalTextIds.has(node.id));
      if (finalIndex >= 0 && finalIndex >= collapseAt) {
        collapseAt = finalIndex;
        boundary = {
          endNodeId: segment[finalIndex - 1]?.id ?? null,
          durationMs: durationBetween(user?.ts, response!.ts) ?? boundary?.durationMs,
          finalTextNodeId: segment[finalIndex]!.id,
        };
      } else if (finalIndex < 0 && !boundary && segment.length > 0) {
        // A partial history page can expose work without an identifiable final reply.
        collapseAt = segment.length;
        boundary = { endNodeId: segment.at(-1)!.id };
      }
    }
    // Compare response identities so notifications and status-only wakeups preserve the final reply.
    const hasUnfinishedContinuation = previous?.finalTextNodeId !== undefined && response !== undefined
      && !response.textNodeIds.includes(previous.finalTextNodeId);
    // A new user input also folds resumed work that has not reached another normal final reply.
    if ((previous === null || hasUnfinishedContinuation) && nextUser?.origin === 'user'
      && !previousBoundaries.has(`process:${nextUser.id}`) && segment.length > 0) {
      collapseAt = segment.length;
      boundary = { endNodeId: segment.at(-1)!.id };
    }
    boundaries.set(groupId, boundary);
    if (collapseAt > 0) {
      rows.push({
        kind: 'process',
        id: groupId,
        rows: groupToolIntervals(segment.slice(0, collapseAt)),
        durationMs: boundary?.durationMs,
      });
    }
    // The previous final reply and all resumed work stay outside until another boundary is confirmed.
    rows.push(...groupToolIntervals(segment.slice(collapseAt)));
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
  return { rows, boundaries };
}
