import type { AgentPhase } from '../../../../shared/types/agent-control';
import { isInterrupted } from '../../../../shared/types/agent-control';

export type StatusKey = 'stopping' | 'interrupted' | 'thinking' | 'waiting' | 'running';

export function resolveStatus(state: { phase: AgentPhase; interrupted?: boolean }): StatusKey {
  if (state.phase === 'stopping') return 'stopping';
  if (isInterrupted(state)) return 'interrupted';
  if (state.phase === 'thinking') return 'thinking';
  if (state.phase === 'waiting') return 'waiting';
  return 'running';
}
