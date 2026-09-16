import type { ToolNode, TranscriptNode, UserNode } from '@/domains/transcript/nodes';
import { activityChips, type ActivityChips } from './activity';

export type FileChangeTotals = Pick<ActivityChips, 'filesChanged' | 'added' | 'removed'>;

export interface FileChangeRecord {
  readonly id: string;
  readonly agentId: string;
  readonly node: ToolNode;
}

export interface RoundFileChanges {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** Each successful call remains separate; these are not a final workspace diff. */
  readonly records: readonly FileChangeRecord[];
}

export interface FileChangeRound {
  readonly id: string;
  readonly title: string;
  readonly files: readonly RoundFileChanges[];
}

export interface SessionFileChanges {
  readonly totals: FileChangeTotals;
  /** Most recent user turn first; only turns with changes are included. */
  readonly rounds: readonly FileChangeRound[];
}

export const EMPTY_FILE_CHANGES: SessionFileChanges = {
  totals: { filesChanged: 0, added: 0, removed: 0 },
  rounds: [],
};

type Mutation = { readonly path: string; readonly added: number; readonly removed: number };
const mutations = new WeakMap<ToolNode, Mutation | null>();

function mutationOf(node: ToolNode): Mutation | null {
  if (mutations.has(node)) return mutations.get(node)!;
  const review = node.artifacts?.find((artifact) => artifact.slot === 'review');
  const path = review?.path ?? (node.fileOp?.kind !== 'read' ? node.fileOp?.path : undefined);
  const stat = path && node.state.phase === 'ok' ? activityChips([node]) : undefined;
  const mutation = path && stat?.filesChanged
    ? { path, added: stat.added, removed: stat.removed }
    : null;
  mutations.set(node, mutation);
  return mutation;
}

type MutableRound = {
  id: string;
  title: string;
  files: Map<string, { path: string; added: number; removed: number; records: FileChangeRecord[] }>;
};

type WorkerInstruction = NonNullable<ToolNode['workerMessage']> & { readonly owner: MutableRound };

function deliveredInstructionOwners(
  deliveries: readonly UserNode[],
  instructions: readonly WorkerInstruction[],
): readonly (MutableRound | 'pending' | undefined)[] {
  const candidates = deliveries.map((delivery) => instructions.flatMap((instruction, index) => (
    delivery.parentSentAt !== undefined
    && instruction.text === (delivery.text ?? '').trim()
    && instruction.callTs <= delivery.parentSentAt
    && (instruction.resultTs === undefined || delivery.parentSentAt <= instruction.resultTs)
      ? [index] : []
  )));
  // Sending is serial. Bound each delivery by its neighbours without assuming every send was consumed.
  let after = -1;
  const lower = candidates.map((indices) => {
    const bound = after;
    after = indices.find((index) => index > after) ?? after;
    return bound;
  });
  let before = instructions.length;
  const upper = new Array<number>(deliveries.length);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    upper[index] = before;
    before = candidates[index]!.filter((candidate) => candidate < before).at(-1) ?? before;
  }
  return candidates.map((indices, index) => {
    const possible = indices.filter((candidate) => candidate > lower[index]! && candidate < upper[index]!)
      .map((candidate) => instructions[candidate]!);
    const owners = new Set(possible.map((instruction) => instruction.owner));
    if (possible.some((instruction) => instruction.resultTs === undefined)) return 'pending';
    return owners.size === 1 ? possible[0]!.owner : undefined;
  });
}

/** Uses the same UserNode boundaries as transcript folding, independently of presentation state. */
export function collectFileChanges(
  agentId: string,
  conversations: ReadonlyMap<string, readonly TranscriptNode[]>,
  includeWorkers: boolean,
): SessionFileChanges {
  const rounds: MutableRound[] = [];
  const creations = new Map<string, MutableRound>();
  const instructions = new Map<string, WorkerInstruction[]>();
  const seen = new Set<string>();
  const paths = new Set<string>();
  let added = 0;
  let removed = 0;
  const makeRound = (id: string, title = ''): MutableRound => {
    const round: MutableRound = { id, title: title.replace(/\s+/g, ' ').trim().slice(0, 100), files: new Map() };
    rounds.push(round);
    return round;
  };
  const mainNodes = conversations.get(agentId) ?? [];
  let owner = makeRound(mainNodes[0]?.id ?? agentId);

  const add = (sourceId: string, node: TranscriptNode, round: MutableRound | undefined) => {
    if (!round || node.kind !== 'tool') return;
    const mutation = mutationOf(node);
    if (!mutation) return;
    const id = JSON.stringify([sourceId, node.id]);
    if (seen.has(id)) return;
    seen.add(id);
    paths.add(mutation.path);
    added += mutation.added;
    removed += mutation.removed;
    let file = round.files.get(mutation.path);
    if (!file) {
      file = { path: mutation.path, added: 0, removed: 0, records: [] };
      round.files.set(mutation.path, file);
    }
    file.added += mutation.added;
    file.removed += mutation.removed;
    file.records.push({ id, agentId: sourceId, node });
  };

  for (const node of mainNodes) {
    if (node.kind === 'user') owner = makeRound(node.id, node.text);
    add(agentId, node, owner);
    if (!includeWorkers) continue;
    if (node.kind === 'worker' && node.workerId) creations.set(node.workerId, owner);
    if (node.kind === 'tool' && node.workerMessage
      && (node.state.phase === 'ok' || node.state.phase === 'running')) {
      const { targetId } = node.workerMessage;
      const queue = instructions.get(targetId) ?? [];
      queue.push({ ...node.workerMessage, owner });
      instructions.set(targetId, queue);
    }
  }

  for (const [workerId, initialOwner] of creations) {
    let executionOwner = initialOwner;
    let pendingInstruction = false;
    const nodes = conversations.get(workerId) ?? [];
    const owners = deliveredInstructionOwners(
      nodes.filter((node): node is UserNode => node.kind === 'user' && node.origin === 'parent'),
      instructions.get(workerId) ?? [],
    );
    let deliveryIndex = 0;
    for (const node of nodes) {
      if (node.kind === 'user' && node.origin === 'parent') {
        const deliveredOwner = owners[deliveryIndex++];
        pendingInstruction = deliveredOwner === 'pending';
        // Indistinguishable settled sends keep the last established execution turn.
        if (deliveredOwner && deliveredOwner !== 'pending') executionOwner = deliveredOwner;
      }
      // A late result stays with the owner at its call's position, not the current main turn.
      add(workerId, node, pendingInstruction ? undefined : executionOwner);
    }
  }

  return {
    totals: { filesChanged: paths.size, added, removed },
    rounds: rounds.filter((round) => round.files.size > 0).reverse().map((round) => ({
      id: round.id,
      title: round.title,
      files: [...round.files.values()].map((file) => ({
        ...file,
        records: file.records.sort((left, right) => left.node.ts - right.node.ts
          || left.node.sourceIndex - right.node.sourceIndex || left.id.localeCompare(right.id)),
      })),
    })),
  };
}
