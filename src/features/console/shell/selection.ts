import type { ConsoleSelection } from '../../../store/uiStore';

export function resolveConsoleSelectedAgentId(input: {
  readonly selection: ConsoleSelection | null;
  readonly sessionAgentIds: readonly string[];
  readonly loadedAgentIds: ReadonlySet<string>;
}): string | null {
  const { selection, sessionAgentIds, loadedAgentIds } = input;
  if (selection?.kind === 'empty') return null;
  if (!selection) return sessionAgentIds[0] ?? null;
  if (selection.kind === 'history') return selection.agentId;
  if (sessionAgentIds.includes(selection.agentId) || loadedAgentIds.has(selection.agentId)) {
    return selection.agentId;
  }
  return sessionAgentIds[0] ?? null;
}
