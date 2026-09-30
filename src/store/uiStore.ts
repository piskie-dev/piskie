/**
 * UI Store
 * 管理界面状态
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import type { AppSettings } from '../../shared/types';
import type { ConfigurableShortcutCommandId } from '../../shared/shortcuts';
import { changeLanguage } from '../i18n';

type Theme = AppSettings['theme'];
type WritableAppSettings = Partial<Omit<AppSettings, 'shortcuts'>>;

const UI_STORAGE_NAME = 'piskie-ui-storage';

export type ConsoleMode = 'dock' | 'thread';

/** 导航形态：edgeDock=隐形左坞，prism=自由棱镜。 */
export type NavScheme = 'edgeDock' | 'prism';

/** 自由棱镜驻留位置(视口坐标,应用时钳制);null = 默认左下 */
export type NavPrismSpot = NonNullable<AppSettings['navPrismSpot']>;

/**
 * 控制台选择只跨页面导航保留，不写入磁盘。
 * null 表示首次进入时自动选择列表首项；empty 表示用户明确打开了空白会话页。
 */
export type ConsoleSelection =
  | { readonly kind: 'live' | 'history'; readonly agentId: string }
  | { readonly kind: 'empty' };

export interface WorkspaceSessionSort {
  readonly mode: 'auto' | 'manual';
  readonly order: readonly string[];
  /** Latest explicit sorting operation; absent in older persisted preferences. */
  readonly revision?: number;
}

interface UIStore {
  // 状态
  theme: Theme;
  sidebarCollapsed: boolean;
  settings: AppSettings | null;
  consoleMode: ConsoleMode;
  consoleSelection: ConsoleSelection | null;
  /** 受管主题背景 URI，null = 无背景；文件本体由主进程管理。 */
  backgroundImage: string | null;
  /** 主题背景遮罩不透明度，范围见 appBackgroundFade.ts 的 APP_BG_MASK_* */
  backgroundMaskOpacity: number;
  /** 壁纸明暗判定：theme=auto 且有壁纸时跟随此值；null=未判定，按深色兜底。 */
  backgroundIsLight: boolean | null;
  /** 左栏默认收起；只记手动展开或明确导航揭示的工作区 key。 */
  expandedWorkspaceGroups: string[];
  /** 按真实分组 key 记忆顺序；空数组表示尚未初始化。 */
  workspaceGroupOrder: string[];
  /** 置顶会话的 AgentRun ID；排序仅在各自工作区分组内生效。 */
  pinnedAgentRunIds: string[];
  hiddenWorkspaceGroupKeys: string[];
  workspaceSessionSort: Record<string, WorkspaceSessionSort>;
  /** 隐形左坞开关（默认开启；与 navPrismEnabled 至少保留一个）。 */
  navEdgeDockEnabled: boolean;
  /** 自由棱镜开关（默认开启；与 navEdgeDockEnabled 至少保留一个）。 */
  navPrismEnabled: boolean;
  /** 自由棱镜驻留位置;null = 默认左下 */
  navPrismSpot: NavPrismSpot | null;

  // Actions - 状态更新
  setSidebarCollapsed: (collapsed: boolean) => void;
  setConsoleMode: (mode: ConsoleMode) => void;
  setConsoleSelection: (selection: ConsoleSelection | null) => void;
  setBackgroundMaskOpacity: (opacity: number) => void;
  setBackgroundIsLight: (isLight: boolean | null) => void;
  toggleWorkspaceGroup: (key: string) => void;
  expandWorkspaceGroup: (key: string) => void;
  setWorkspaceGroupOrder: (order: string[]) => void;
  toggleAgentRunPin: (agentId: string) => void;
  hideWorkspaceGroup: (key: string) => void;
  restoreWorkspaceGroup: (key: string) => void;
  setWorkspaceSessionSort: (key: string, preference: Pick<WorkspaceSessionSort, 'mode' | 'order'>) => void;
  reconcileWorkspaceSessionSort: (
    defaultWorkspacePath?: string,
    agentIdsByWorkspace?: Readonly<Record<string, readonly string[]>>,
  ) => void;
  forgetSessionOrder: (agentId: string) => void;
  setSettings: (settings: AppSettings) => void;

  // Actions - 业务操作
  fetchSettings: () => Promise<void>;
  updateSettings: (settings: WritableAppSettings) => Promise<boolean>;
  updateShortcut: (
    commandId: ConfigurableShortcutCommandId,
    override: string | null,
  ) => Promise<boolean>;
}

let settingsOperationQueue: Promise<void> = Promise.resolve();

function enqueueSettingsOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = settingsOperationQueue.then(operation, operation);
  settingsOperationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export const useUIStore = create<UIStore>()(
  persist<UIStore, [], [], PersistedUIState>(
    (set, get) => ({
      // 初始状态
      theme: 'auto',
      sidebarCollapsed: true,
      settings: null,
      // 默认使用对话模式；用户切换后由 persist 记忆最后一次选择。
      consoleMode: 'thread',
      consoleSelection: null,
      backgroundImage: DEFAULT_SETTINGS.backgroundImage,
      backgroundMaskOpacity: DEFAULT_SETTINGS.backgroundMaskOpacity,
      backgroundIsLight: null,
      expandedWorkspaceGroups: [],
      workspaceGroupOrder: [],
      pinnedAgentRunIds: [],
      hiddenWorkspaceGroupKeys: [],
      workspaceSessionSort: {},
      navEdgeDockEnabled: DEFAULT_SETTINGS.navEdgeDockEnabled,
      navPrismEnabled: DEFAULT_SETTINGS.navPrismEnabled,
      navPrismSpot: DEFAULT_SETTINGS.navPrismSpot,

      // Actions - 状态更新
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setSettings: (settings) => set((state) => projectAppSettings(state, settings)),
      setConsoleMode: (mode) => set({ consoleMode: mode }),
      setConsoleSelection: (selection) => set({ consoleSelection: selection }),
      toggleWorkspaceGroup: (key) => set((state) => ({
        expandedWorkspaceGroups: state.expandedWorkspaceGroups.includes(key)
          ? state.expandedWorkspaceGroups.filter((item) => item !== key)
          : [...state.expandedWorkspaceGroups, key],
      })),
      expandWorkspaceGroup: (key) => {
        if (get().expandedWorkspaceGroups.includes(key)) return;
        set((state) => ({ expandedWorkspaceGroups: [...state.expandedWorkspaceGroups, key] }));
      },
      setWorkspaceGroupOrder: (order) => set({ workspaceGroupOrder: order }),
      hideWorkspaceGroup: (key) => {
        if (get().hiddenWorkspaceGroupKeys.includes(key)) return;
        set((state) => ({ hiddenWorkspaceGroupKeys: [...state.hiddenWorkspaceGroupKeys, key] }));
      },
      restoreWorkspaceGroup: (key) => {
        if (!get().hiddenWorkspaceGroupKeys.includes(key)) return;
        set((state) => ({ hiddenWorkspaceGroupKeys: state.hiddenWorkspaceGroupKeys.filter((item) => item !== key) }));
      },
      setWorkspaceSessionSort: (key, preference) => set((state) => ({
        workspaceSessionSort: {
          ...state.workspaceSessionSort,
          [key]: {
            mode: preference.mode,
            order: preference.mode === 'manual' ? [...preference.order] : [],
            revision: Object.values(state.workspaceSessionSort).reduce(
              (latest, item) => Math.max(latest, item.revision ?? 0), 0,
            ) + 1,
          },
        },
      })),
      reconcileWorkspaceSessionSort: (defaultWorkspacePath, agentIdsByWorkspace) => {
        const saved = get().workspaceSessionSort;
        let next = normalizeWorkspaceSessionSort(saved, defaultWorkspacePath);
        if (agentIdsByWorkspace) {
          const existing = new Set(Object.values(agentIdsByWorkspace).flat());
          for (const [key, preference] of Object.entries(next)) {
            if (preference.mode !== 'manual') continue;
            const known = new Set(preference.order);
            const added = agentIdsByWorkspace[key]?.filter((id) => !known.has(id)) ?? [];
            const order = [...added, ...preference.order.filter((id) => existing.has(id))];
            if (order.length !== preference.order.length || order.some((id, index) => id !== preference.order[index])) {
              next = { ...next, [key]: { ...preference, order } };
            }
          }
        }
        if (next !== saved) set({ workspaceSessionSort: next });
      },
      toggleAgentRunPin: (agentId) => set((state) => ({
        pinnedAgentRunIds: state.pinnedAgentRunIds.includes(agentId)
          ? state.pinnedAgentRunIds.filter((item) => item !== agentId)
          : [...state.pinnedAgentRunIds, agentId],
        workspaceSessionSort: Object.fromEntries(Object.entries(state.workspaceSessionSort).map(([key, preference]) => [
          key, preference.mode === 'manual' && preference.order.includes(agentId)
            ? { ...preference, order: [agentId, ...preference.order.filter((id) => id !== agentId)] }
            : preference,
        ])),
      })),
      forgetSessionOrder: (agentId) => set((state) => ({
        pinnedAgentRunIds: state.pinnedAgentRunIds.filter((id) => id !== agentId),
        workspaceSessionSort: Object.fromEntries(Object.entries(state.workspaceSessionSort).map(([key, preference]) => [
          key, { ...preference, order: preference.order.filter((id) => id !== agentId) },
        ])),
      })),
      setBackgroundMaskOpacity: (opacity) => set({ backgroundMaskOpacity: opacity }),
      setBackgroundIsLight: (isLight) => set({ backgroundIsLight: isLight }),

      // Actions - 业务操作
      fetchSettings: () => enqueueSettingsOperation(async () => {
        try {
          const settings = await window.piskie.configuration.settings.read();
          set((state) => projectAppSettings(state, settings));
          if (settings.language) {
            await changeLanguage(settings.language);
          }
        } catch (error) {
          console.error('Failed to fetch settings:', error);
        }
      }),

      updateSettings: (newSettings) => enqueueSettingsOperation(async () => {
        try {
          const currentSettings = get().settings ?? DEFAULT_SETTINGS;
          const changes = changedAppSettings(currentSettings, newSettings);
          if (Object.keys(changes).length === 0) return true;
          await window.piskie.configuration.settings.writeAll(changes);
          const updatedSettings = await window.piskie.configuration.settings.read();
          set((state) => projectAppSettings(state, updatedSettings));
          if (updatedSettings.language !== currentSettings.language) {
            await changeLanguage(updatedSettings.language);
          }
          return true;
        } catch (error) {
          console.error('Failed to update settings:', error);
          return false;
        }
      }),

      updateShortcut: (commandId, override) => enqueueSettingsOperation(async () => {
        try {
          await window.piskie.configuration.settings.writeShortcut(commandId, override);
          const settings = await window.piskie.configuration.settings.read();
          set((state) => projectAppSettings(state, settings));
          return true;
        } catch (error) {
          console.error('Failed to update shortcut:', error);
          return false;
        }
      }),
    }),
    {
      name: UI_STORAGE_NAME,
      version: 6,
      /**
       * v6 增加侧栏隐藏和工作区会话排序偏好。v5 增加工作区内会话置顶偏好。v4 工作区默认收起，退役 collapsedWorkspaceGroups；旧数据不能推断哪些组
       * 曾被手动展开，因此按新的默认值初始化。读取只投影当前字段。
       * 导航与背景偏好由 app-settings 持久化，localStorage 中的旧值直接忽略。
       */
      migrate: (persisted, version) => readPersistedUIState(persisted, version) as never,
      merge: (persisted, current) => ({
        ...current,
        ...readPersistedUIState(persisted, 6),
      }),
      partialize: selectPersistedUIState,
    }
  )
);

/** Merge the resolved default-path alias using the latest explicit sorting choice. */
export function normalizeWorkspaceSessionSort(
  preferences: Record<string, WorkspaceSessionSort>,
  defaultWorkspacePath?: string,
): Record<string, WorkspaceSessionSort> {
  if (!defaultWorkspacePath || !preferences[defaultWorkspacePath]) return preferences;
  const { [defaultWorkspacePath]: alias, ...rest } = preferences;
  const current = rest[''];
  return {
    ...rest,
    '': !current || (alias!.revision ?? 0) > (current.revision ?? 0) ? alias! : current,
  };
}

export type PersistedUIState = Pick<
  UIStore,
  | 'theme'
  | 'sidebarCollapsed'
  | 'consoleMode'
  | 'expandedWorkspaceGroups'
  | 'workspaceGroupOrder'
  | 'pinnedAgentRunIds'
  | 'hiddenWorkspaceGroupKeys'
  | 'workspaceSessionSort'
>;

export function selectPersistedUIState(state: PersistedUIState): PersistedUIState {
  return {
    theme: state.theme,
    sidebarCollapsed: state.sidebarCollapsed,
    consoleMode: state.consoleMode,
    expandedWorkspaceGroups: state.expandedWorkspaceGroups,
    workspaceGroupOrder: state.workspaceGroupOrder,
    pinnedAgentRunIds: state.pinnedAgentRunIds,
    hiddenWorkspaceGroupKeys: state.hiddenWorkspaceGroupKeys,
    workspaceSessionSort: Object.fromEntries(Object.entries(state.workspaceSessionSort).map(([key, preference]) => [
      key, {
        mode: preference.mode,
        order: preference.mode === 'manual' ? [...preference.order] : [],
        ...(preference.revision === undefined ? {} : { revision: preference.revision }),
      },
    ])),
  };
}

export function readPersistedUIState(value: unknown, version: number): Partial<PersistedUIState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const state = value as Record<string, unknown>;
  const next: Partial<PersistedUIState> = {};

  if (state.theme === 'light' || state.theme === 'dark' || state.theme === 'auto') {
    next.theme = state.theme;
  }
  if (typeof state.sidebarCollapsed === 'boolean') next.sidebarCollapsed = state.sidebarCollapsed;
  if (version >= 1 && (state.consoleMode === 'dock' || state.consoleMode === 'thread')) {
    next.consoleMode = state.consoleMode;
  } else if (state.consoleMode === 'codex') {
    // 2026-08-25 对话模式内部代号 codex→thread:磁盘存量值读取端映射,老用户无感
    next.consoleMode = 'thread';
  } else if (version < 1) {
    next.consoleMode = 'thread';
  }
  for (const key of ['expandedWorkspaceGroups', 'workspaceGroupOrder', 'hiddenWorkspaceGroupKeys'] as const) {
    const keys = state[key];
    if (Array.isArray(keys) && keys.every((item) => typeof item === 'string')) {
      next[key] = [...new Set(keys)];
    }
  }
  const pinnedAgentRunIds = state.pinnedAgentRunIds;
  if (version >= 5 && Array.isArray(pinnedAgentRunIds)
    && pinnedAgentRunIds.every((item) => typeof item === 'string')) {
    next.pinnedAgentRunIds = [...new Set(pinnedAgentRunIds)];
  }

  if (state.workspaceSessionSort && typeof state.workspaceSessionSort === 'object' && !Array.isArray(state.workspaceSessionSort)) {
    next.workspaceSessionSort = Object.fromEntries(Object.entries(state.workspaceSessionSort).flatMap<[string, WorkspaceSessionSort]>(([key, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const preference = value as Record<string, unknown>;
      const revision = typeof preference.revision === 'number' && Number.isSafeInteger(preference.revision)
        && preference.revision >= 0 ? { revision: preference.revision } : {};
      if (preference.mode === 'auto') return [[key, { mode: 'auto', order: [], ...revision }]];
      if (preference.mode !== 'manual' || !Array.isArray(preference.order)
        || !preference.order.every((id) => typeof id === 'string')) return [];
      return [[key, { mode: 'manual', order: [...new Set(preference.order)], ...revision }]];
    }));
  }
  return next;
}

function projectAppSettings(state: UIStore, settings: AppSettings): Partial<UIStore> {
  return {
    settings,
    theme: settings.theme,
    navEdgeDockEnabled: settings.navEdgeDockEnabled,
    navPrismEnabled: settings.navPrismEnabled,
    navPrismSpot: settings.navPrismSpot,
    backgroundImage: settings.backgroundImage,
    backgroundMaskOpacity: settings.backgroundMaskOpacity,
    backgroundIsLight: state.backgroundImage === settings.backgroundImage
      ? state.backgroundIsLight
      : null,
  };
}

function changedAppSettings(
  current: AppSettings,
  candidate: WritableAppSettings,
): WritableAppSettings {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate) as Array<[keyof AppSettings, unknown]>) {
    if (value === undefined || appSettingValuesEqual(current[key], value)) continue;
    changes[key] = value;
  }
  return changes as WritableAppSettings;
}

function appSettingValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => appSettingValuesEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => (
      Object.hasOwn(rightRecord, key)
      && appSettingValuesEqual(leftRecord[key], rightRecord[key])
    ));
}
