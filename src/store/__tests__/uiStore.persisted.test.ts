import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readPersistedUIState,
  selectPersistedUIState,
  type PersistedUIState,
  useUIStore,
} from '../uiStore';
import { DEFAULT_SETTINGS } from '../../../shared/constants';

describe('uiStore persisted boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads only Renderer-owned fields while dropping app-settings and unknown fields', () => {
    expect(readPersistedUIState({
      theme: 'dark',
      sidebarCollapsed: false,
      consoleMode: 'dock',
      collapsedWorkspaceGroups: ['workspace-a'],
      navEdgeDockEnabled: false,
      navPrismEnabled: true,
      navPrismSpot: { x: 100, y: 200 },
      backgroundImage: 'file:///data/themes/background.png',
      backgroundMaskOpacity: 0.4,
      consoleSelection: { kind: 'live', agentId: 'agent-a' },
      canvasLayout: 'tree',
      futureField: 'ignored',
    }, 1)).toEqual({
      theme: 'dark',
      sidebarCollapsed: false,
      consoleMode: 'dock',
    });
  });

  it('restores workspace preferences by full key, including the default workspace', () => {
    expect(readPersistedUIState({
      expandedWorkspaceGroups: ['', '/sample/alpha', '/sample/alpha'],
      workspaceGroupOrder: ['/sample/beta', '', '/sample/alpha', ''],
    }, 4)).toEqual({
      expandedWorkspaceGroups: ['', '/sample/alpha'],
      workspaceGroupOrder: ['/sample/beta', '', '/sample/alpha'],
    });
  });

  it('ignores malformed persisted workspace preferences', () => {
    expect(readPersistedUIState({
      theme: 'light',
      expandedWorkspaceGroups: [null],
      workspaceGroupOrder: 'invalid',
    }, 4)).toEqual({ theme: 'light' });
  });

  it('does not infer the current console mode from pre-v1 layout data', () => {
    expect(readPersistedUIState({ canvasLayout: 'tree' }, 0)).toEqual({
      consoleMode: 'thread',
    });
  });

  it('maps the legacy codex console mode to thread(2026-08-25 改名迁移)', () => {
    expect(readPersistedUIState({ consoleMode: 'codex' }, 3)).toEqual({
      consoleMode: 'thread',
    });
  });

  it('writes only the current persisted schema', () => {
    const current: PersistedUIState & Record<string, unknown> = {
      theme: 'auto',
      sidebarCollapsed: true,
      consoleMode: 'thread',
      expandedWorkspaceGroups: [''],
      workspaceGroupOrder: ['/sample/alpha', ''],
      collapsedWorkspaceGroups: [],
      navEdgeDockEnabled: true,
      navPrismEnabled: false,
      navPrismSpot: { x: 24, y: 640 },
      consoleSelection: { kind: 'empty' },
      canvasLayout: 'dock',
      futureField: true,
    };

    expect(selectPersistedUIState(current)).toEqual({
      theme: 'auto',
      sidebarCollapsed: true,
      consoleMode: 'thread',
      expandedWorkspaceGroups: [''],
      workspaceGroupOrder: ['/sample/alpha', ''],
    });
  });

  it('discards old localStorage preferences without writing them to app-settings', async () => {
    const writeAll = vi.fn(async () => undefined);
    vi.stubGlobal('window', {
      piskie: {
        configuration: {
          settings: {
            read: vi.fn(async () => DEFAULT_SETTINGS),
            writeAll,
          },
        },
      },
    });
    useUIStore.setState({
      settings: null,
      navEdgeDockEnabled: false,
      navPrismEnabled: true,
      backgroundMaskOpacity: 0.4,
    });

    await useUIStore.getState().fetchSettings();

    expect(writeAll).not.toHaveBeenCalled();
    expect(useUIStore.getState()).toMatchObject({
      settings: DEFAULT_SETTINGS,
      navEdgeDockEnabled: DEFAULT_SETTINGS.navEdgeDockEnabled,
      navPrismEnabled: DEFAULT_SETTINGS.navPrismEnabled,
      backgroundMaskOpacity: DEFAULT_SETTINGS.backgroundMaskOpacity,
    });
  });
});
