import type { ProcessBoundary, TranscriptProcessBoundaries } from '../data/transcriptRows';

interface TranscriptPresentationEntry {
  readonly processBoundaries: TranscriptProcessBoundaries;
  readonly openGroups: ReadonlySet<string>;
}

const entries = new Map<string, TranscriptPresentationEntry>();

function sameBoundary(left: ProcessBoundary | null, right: ProcessBoundary | null): boolean {
  return left === right || (left !== null && right !== null
    && left.endNodeId === right.endNodeId
    && left.durationMs === right.durationMs
    && left.finalTextNodeId === right.finalTextNodeId);
}

function boundaryPosition(
  boundary: ProcessBoundary,
  nodePositions: ReadonlyMap<string, number>,
): number | undefined {
  const ids = [boundary.endNodeId, boundary.finalTextNodeId]
    .filter((id): id is string => id !== null && id !== undefined);
  let position = -1;
  for (const id of ids) {
    const next = nodePositions.get(id);
    if (next === undefined) return undefined;
    position = Math.max(position, next);
  }
  return position;
}

function mergeBoundary(
  current: ProcessBoundary | null,
  candidate: ProcessBoundary | null,
  nodePositions: ReadonlyMap<string, number>,
): ProcessBoundary | null {
  if (sameBoundary(current, candidate)) return current;
  if (current === null) return candidate;
  if (candidate === null) return current;

  const currentPosition = boundaryPosition(current, nodePositions);
  const candidatePosition = boundaryPosition(candidate, nodePositions);
  if (currentPosition === undefined || candidatePosition === undefined) return current;
  if (candidatePosition > currentPosition) return candidate;
  if (candidatePosition < currentPosition) return current;

  if (current.endNodeId !== candidate.endNodeId
    || current.finalTextNodeId !== candidate.finalTextNodeId) {
    return current;
  }
  if (current.durationMs === undefined) return candidate;
  if (candidate.durationMs === undefined || candidate.durationMs <= current.durationMs) return current;
  return candidate;
}

/**
 * Merge a committed render into the target's renderer-lifetime presentation state.
 * Groups are never removed by an older owner, and a boundary only moves forward in
 * the node order visible to the committing render.
 */
export function mergeTranscriptProcessBoundaries(
  key: string,
  candidate: TranscriptProcessBoundaries,
  orderedNodeIds: readonly string[],
): TranscriptProcessBoundaries {
  const entry = entries.get(key);
  const current = entry?.processBoundaries ?? new Map<string, ProcessBoundary | null>();
  const nodePositions = new Map(orderedNodeIds.map((id, index) => [id, index]));
  const merged = new Map(current);
  let changed = false;

  for (const [groupId, boundary] of candidate) {
    if (!current.has(groupId)) {
      merged.set(groupId, boundary);
      changed = true;
      continue;
    }
    const next = mergeBoundary(current.get(groupId)!, boundary, nodePositions);
    if (!sameBoundary(current.get(groupId)!, next)) {
      merged.set(groupId, next);
      changed = true;
    }
  }

  if (!changed) return current;
  entries.set(key, {
    processBoundaries: merged,
    openGroups: entry?.openGroups ?? new Set(),
  });
  return merged;
}

export function readTranscriptProcessBoundaries(key: string): TranscriptProcessBoundaries | undefined {
  return entries.get(key)?.processBoundaries;
}

export function readTranscriptOpenGroups(key: string): ReadonlySet<string> | undefined {
  return entries.get(key)?.openGroups;
}

/** The latest explicit interaction wins while preserving choices for other groups. */
export function setTranscriptGroupOpen(key: string, groupId: string, open: boolean): ReadonlySet<string> {
  const entry = entries.get(key);
  const current = entry?.openGroups ?? new Set<string>();
  if (current.has(groupId) === open) return current;

  const next = new Set(current);
  if (open) next.add(groupId);
  else next.delete(groupId);
  entries.set(key, {
    processBoundaries: entry?.processBoundaries ?? new Map(),
    openGroups: next,
  });
  return next;
}

export function clearTranscriptPresentationMemory(): void {
  entries.clear();
}
