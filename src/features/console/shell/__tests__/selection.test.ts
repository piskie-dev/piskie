import { describe, expect, it } from 'vitest';

import type { ConsoleSelection } from '../../../../store/uiStore';
import { resolveConsoleSelectedAgentId } from '../selection';

function resolve(
  selection: ConsoleSelection | null,
  sessionAgentIds: readonly string[],
  loadedAgentIds: readonly string[] = sessionAgentIds,
): string | null {
  return resolveConsoleSelectedAgentId({
    selection,
    sessionAgentIds,
    loadedAgentIds: new Set(loadedAgentIds),
  });
}

describe('resolveConsoleSelectedAgentId', () => {
  it('keeps an explicit selection when an IM session moves to the front', () => {
    const selection: ConsoleSelection = { kind: 'live', agentId: 'local-agent' };

    expect(resolve(selection, ['local-agent'])).toBe('local-agent');
    expect(resolve(selection, ['im-agent', 'local-agent'])).toBe('local-agent');
  });

  it('uses the first session only before the user has made a selection', () => {
    expect(resolve(null, ['local-agent'])).toBe('local-agent');
    expect(resolve(null, ['im-agent', 'local-agent'])).toBe('im-agent');
  });

  it('preserves the explicitly requested empty page', () => {
    expect(resolve({ kind: 'empty' }, ['im-agent', 'local-agent'])).toBeNull();
  });

  it('keeps a history selection independently of loaded live sessions', () => {
    expect(resolve({ kind: 'history', agentId: 'history-agent' }, ['im-agent'])).toBe('history-agent');
  });

  it('falls back when the selected live session is removed', () => {
    expect(resolve(
      { kind: 'live', agentId: 'removed-agent' },
      ['remaining-agent'],
      ['remaining-agent'],
    )).toBe('remaining-agent');
  });
});
