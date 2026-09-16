import type { AgentControlSnapshot } from '@shared/electron-contracts/agent-runs';
import type { ImageNodePublicState } from '@shared/types';

export interface AgentRunAttention {
  readonly unread: boolean;
  readonly unreadActionIds: readonly string[];
}

/** Only entries with a current user decision participate; progress and links do not. */
export function pendingActionIds(state: AgentControlSnapshot): string[] {
  const ids: string[] = [];
  const collect = (agentId: string, target: Pick<AgentControlSnapshot, 'pendingToolCall' | 'imageNodes'>) => {
    if (target.pendingToolCall) ids.push(JSON.stringify([agentId, 'approval', target.pendingToolCall.id]));
    for (const node of target.imageNodes ?? []) {
      if (node.status === 'preview' || node.status === 'pending_approval') {
        ids.push(imageReviewId(agentId, node));
      }
    }
  };
  collect(state.agentId, state);
  if (state.pendingQuestion) {
    ids.push(JSON.stringify([state.agentId, 'question', state.pendingQuestion.id, state.pendingQuestion.questions]));
  }
  for (const child of state.children) collect(child.id, child);
  return ids;
}

function imageReviewId(agentId: string, node: ImageNodePublicState): string {
  // Entering edit keeps the same decision; a regenerated candidate needs a fresh review.
  return JSON.stringify([agentId, 'image', node.id, node.images.map((image) => [
    image.id, image.version, image.status, image.error,
  ])]);
}

export function hasSettledResponse(state: AgentControlSnapshot): boolean {
  return state.phase === 'waiting'
    && state.activeStartedAt === undefined
    && !state.interrupted
    && !state.pendingToolCall
    && !state.pendingQuestion
    && state.aiRequestState?.phase === 'finished'
    && state.aiRequestState.outcome === 'success';
}
