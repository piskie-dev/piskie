import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readPersistedUIState,
  selectPersistedUIState,
  type PersistedUIState,
  useUIStore,
} from '../uiStore';
import { DEFAULT_SETTINGS } from '../../../shared/constants';
import type { AppSettings } from '../../../shared/types';

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
      autoCheckAndDownloadUpdates: false,
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
      pinnedAgentRunIds: ['agent-b', 'agent-a', 'agent-b'],
    }, 5)).toEqual({
      expandedWorkspaceGroups: ['', '/sample/alpha'],
      workspaceGroupOrder: ['/sample/beta', '', '/sample/alpha'],
      pinnedAgentRunIds: ['agent-b', 'agent-a'],
    });
  });

  it('ignores malformed persisted workspace preferences', () => {
    expect(readPersistedUIState({
      theme: 'light',
      expandedWorkspaceGroups: [null],
      workspaceGroupOrder: 'invalid',
      pinnedAgentRunIds: ['valid', null],
    }, 5)).toEqual({ theme: 'light' });
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
      pinnedAgentRunIds: ['agent-a'],
      collapsedWorkspaceGroups: [],
      navEdgeDockEnabled: true,
      navPrismEnabled: false,
      autoCheckAndDownloadUpdates: false,
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
      pinnedAgentRunIds: ['agent-a'],
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
            writeShortcut: vi.fn(async () => undefined),
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

  it('writes one shortcut command and replaces local state with the authoritative snapshot', async () => {
    let authoritative: AppSettings = structuredClone(DEFAULT_SETTINGS);
    const writeShortcut = vi.fn(async () => {
      authoritative = {
        ...authoritative,
        shortcuts: { 'agent.interruptCurrent': null },
      };
    });
    vi.stubGlobal('window', {
      piskie: {
        configuration: {
          settings: {
            read: vi.fn(async () => structuredClone(authoritative)),
            writeAll: vi.fn(async () => undefined),
            writeShortcut,
          },
        },
      },
    });
    useUIStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });

    await expect(useUIStore.getState().updateShortcut(
      'agent.interruptCurrent',
      null,
    )).resolves.toBe(true);

    expect(writeShortcut).toHaveBeenCalledWith('agent.interruptCurrent', null);
    expect(useUIStore.getState().settings?.shortcuts).toEqual({
      'agent.interruptCurrent': null,
    });
  });

  it('still skips a structurally equal prism-position object', async () => {
    const writeAll = vi.fn(async () => undefined);
    vi.stubGlobal('window', {
      piskie: {
        configuration: {
          settings: {
            read: vi.fn(async () => DEFAULT_SETTINGS),
            writeAll,
            writeShortcut: vi.fn(async () => undefined),
          },
        },
      },
    });
    useUIStore.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        navPrismSpot: { x: 12, y: 34 },
      },
    });

    await expect(useUIStore.getState().updateSettings({
      navPrismSpot: { x: 12, y: 34 },
    })).resolves.toBe(true);

    expect(writeAll).not.toHaveBeenCalled();
  });

  it('serializes settings operations and rereads before committing local state', async () => {
    let releaseWrite: (() => void) | undefined;
    let authoritative: AppSettings = structuredClone(DEFAULT_SETTINGS);
    const writeStarted = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeAll = vi.fn(async (changes: { theme?: 'light' | 'dark' | 'auto' }) => {
      await writeStarted;
      authoritative = { ...authoritative, ...changes };
    });
    const read = vi.fn(async () => structuredClone(authoritative));
    vi.stubGlobal('window', {
      piskie: {
        configuration: {
          settings: {
            read,
            writeAll,
            writeShortcut: vi.fn(async () => undefined),
          },
        },
      },
    });
    useUIStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });

    const update = useUIStore.getState().updateSettings({ theme: 'dark' });
    await Promise.resolve();
    authoritative = {
      ...authoritative,
      shortcuts: { 'tool.promoteToBackground': null },
    };
    const fetch = useUIStore.getState().fetchSettings();
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();

    releaseWrite?.();
    await Promise.all([update, fetch]);

    expect(useUIStore.getState().settings).toMatchObject({
      theme: 'dark',
      shortcuts: { 'tool.promoteToBackground': null },
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
