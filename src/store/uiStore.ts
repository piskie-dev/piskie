/**
 * UI Store
 * 管理界面状态
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import type { AppSettings } from '../../shared/types';
import { changeLanguage } from '../i18n';

type Theme = AppSettings['theme'];

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
  /** 左栏会话树里被手动折叠的工作区分组 key（默认全展开，只记折叠的） */
  collapsedWorkspaceGroups: string[];
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
  setSettings: (settings: AppSettings) => void;

  // Actions - 业务操作
  fetchSettings: () => Promise<void>;
  updateSettings: (settings: Partial<AppSettings>) => Promise<boolean>;
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
      collapsedWorkspaceGroups: [],
      navEdgeDockEnabled: DEFAULT_SETTINGS.navEdgeDockEnabled,
      navPrismEnabled: DEFAULT_SETTINGS.navPrismEnabled,
      navPrismSpot: DEFAULT_SETTINGS.navPrismSpot,

      // Actions - 状态更新
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setSettings: (settings) => set((state) => projectAppSettings(state, settings)),
      setConsoleMode: (mode) => set({ consoleMode: mode }),
      setConsoleSelection: (selection) => set({ consoleSelection: selection }),
      toggleWorkspaceGroup: (key) => set((state) => ({
        collapsedWorkspaceGroups: state.collapsedWorkspaceGroups.includes(key)
          ? state.collapsedWorkspaceGroups.filter((item) => item !== key)
          : [...state.collapsedWorkspaceGroups, key],
      })),
      setBackgroundMaskOpacity: (opacity) => set({ backgroundMaskOpacity: opacity }),
      setBackgroundIsLight: (isLight) => set({ backgroundIsLight: isLight }),

      // Actions - 业务操作
      fetchSettings: async () => {
        try {
          const settings = await window.piskie.configuration.settings.read();
          set((state) => projectAppSettings(state, settings));
          if (settings.language) {
            await changeLanguage(settings.language);
          }
        } catch (error) {
          console.error('Failed to fetch settings:', error);
        }
      },

      updateSettings: async (newSettings) => {
        try {
          const currentSettings = get().settings ?? DEFAULT_SETTINGS;
          const changes = changedAppSettings(currentSettings, newSettings);
          if (Object.keys(changes).length === 0) return true;
          await window.piskie.configuration.settings.writeAll(changes);
          const updatedSettings = { ...currentSettings, ...changes };
          set((state) => projectAppSettings(state, updatedSettings));
          if (changes.language) {
            await changeLanguage(changes.language);
          }
          return true;
        } catch (error) {
          console.error('Failed to update settings:', error);
          return false;
        }
      },
    }),
    {
      name: UI_STORAGE_NAME,
      version: 3,
      /**
       * v2 退役无消费者的 canvasLayout。读取边界只投影当前字段，旧值和未知字段
       * 都不会合并进运行时；consoleMode 不从旧 tree/dock 偏好推断。
       * 导航与背景偏好由 app-settings 持久化，localStorage 中的旧值直接忽略。
       */
      migrate: (persisted, version) => readPersistedUIState(persisted, version) as never,
      merge: (persisted, current) => ({
        ...current,
        ...readPersistedUIState(persisted, 3),
      }),
      partialize: selectPersistedUIState,
    }
  )
);

export type PersistedUIState = Pick<
  UIStore,
  | 'theme'
  | 'sidebarCollapsed'
  | 'consoleMode'
  | 'collapsedWorkspaceGroups'
>;

export function selectPersistedUIState(state: PersistedUIState): PersistedUIState {
  return {
    theme: state.theme,
    sidebarCollapsed: state.sidebarCollapsed,
    consoleMode: state.consoleMode,
    collapsedWorkspaceGroups: state.collapsedWorkspaceGroups,
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
  if (
    Array.isArray(state.collapsedWorkspaceGroups)
    && state.collapsedWorkspaceGroups.every((item) => typeof item === 'string')
  ) {
    next.collapsedWorkspaceGroups = [...state.collapsedWorkspaceGroups];
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
  candidate: Partial<AppSettings>,
): Partial<AppSettings> {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate) as Array<[keyof AppSettings, unknown]>) {
    if (value === undefined || appSettingValuesEqual(current[key], value)) continue;
    changes[key] = value;
  }
  return changes as Partial<AppSettings>;
}

function appSettingValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftSpot = left as Partial<NavPrismSpot>;
  const rightSpot = right as Partial<NavPrismSpot>;
  return leftSpot.x === rightSpot.x && leftSpot.y === rightSpot.y;
}
