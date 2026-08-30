/**
 * 页面壳的状态与数据。
 *
 * 壳只负责三样：模式切换、创建入口、全局 overlay。它需要的状态与数据集中在这里，
 * 不散回 `ConsolePage`。
 *
 * 选中态：没有显式选中时落到列表首项（排序已定，见 `data/session`）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useAgentControl,
  useAgentRunPreview,
  useRendererRuntime,
} from '../../../renderer-runtime/hooks';
import { useUIStore, type ConsoleMode } from '../../../store/uiStore';
import { useConsoleActions } from '../data/actions';
import { useHistoryRows, useSessionRows, type HistoryRow } from '../data/session';
import type { SessionMenuSource } from '../data/sessionMenu';
import { resolveConsoleSelectedAgentId } from './selection';

export type { ConsoleMode };

export interface ConsoleImagePreview {
  readonly urls: readonly string[];
  readonly index: number;
}

export interface ConsoleShell {
  readonly sessions: ReturnType<typeof useSessionRows>;
  readonly history: readonly HistoryRow[];
  readonly selectedAgentId: string | null;
  readonly selectSession: (agentId: string) => void;
  /** 回到空态 */
  readonly newSession: () => void;
  readonly openHistory: (row: HistoryRow) => void;
  readonly menuSourceOf: (agentId: string) => SessionMenuSource;
  readonly mode: ConsoleMode;
  readonly setMode: (mode: ConsoleMode) => void;
  readonly sessionsCollapsed: boolean;
  readonly toggleSessions: () => void;
  readonly previewImage: ConsoleImagePreview | null;
  readonly setPreviewImage: (
    src: string | null,
    contextUrls?: readonly string[],
    contextIndex?: number,
  ) => void;
  /**
   * 顶栏徽标要求定位到某个 worker 时的**一次性请求**（`useHeaderAction` 发）。
   *
   * 带 `requestId` 是因为同一个 worker 可能被连续 reveal 两次（比如又来一条待确认），
   * 只比对 workerId 的话第二次不会触发。模式侧按 requestId 变化来消费。
   */
  readonly revealWorker: { readonly workerId: string; readonly requestId: number } | null;
  readonly reveal: (target: { agentId: string; workerId?: string }) => void;
}

export function useConsoleShell(): ConsoleShell {
  const sessions = useSessionRows();
  const history = useHistoryRows();
  const actions = useConsoleActions();
  const runtime = useRendererRuntime();

  const controlStates = useAgentControl((store) => store.agentsById);
  const historyPreview = useAgentRunPreview((store) => store.state);

  // 显示方式是**持久化偏好**（替代 canvasLayout），不是组件态
  const mode = useUIStore((store) => store.consoleMode);
  const setMode = useUIStore((store) => store.setConsoleMode);
  const selection = useUIStore((store) => store.consoleSelection);
  const setSelection = useUIStore((store) => store.setConsoleSelection);

  /**
   * 选中态跨页面导航保留：`selection` 是用户点过的，`empty` 表示"我要回空态"。
   * 「新建会话」的语义是回到欢迎页，不是打开创建弹层——两者要分清（「新建 ≠ 恢复」同理）。
   *
   * **`kind` 不是冗余信息，是修 bug 的关键**：历史记录的 agentId 既不在 `sessions`
   * 里、也不在 `controlStates` 里（Agent Run Repository 只把它写入独立 preview state），
   * "不在 sessions/controlStates 就回落首项"的判据
   * 会把它立刻丢掉 —— 点历史行**完全没反应**（无在跑会话时回落成 null 停在空态）。
   * 用 `kind` 记住"这是一次恢复"，恢复态的 id 无条件成立，也就不依赖异步加载时序。
   */
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [previewImage, setPreviewImageState] = useState<ConsoleImagePreview | null>(null);

  const setPreviewImage = useCallback<ConsoleShell['setPreviewImage']>(
    (src, contextUrls, contextIndex) => {
      setPreviewImageState(src === null ? null : {
        urls: contextUrls ?? [src],
        index: contextIndex ?? 0,
      });
    },
    [],
  );

  // Agent control is hydrated by Runtime; persisted runs are route-scoped.
  useEffect(() => {
    void runtime.agentRuns.refresh();
  }, [runtime]);

  // 显式选中优先；它指向的会话消失后自动落到首项（不需要 effect 里 setState 纠正）
  const selectedAgentId = useMemo(() => {
    return resolveConsoleSelectedAgentId({
      selection,
      sessionAgentIds: sessions.map((row) => row.agentId),
      loadedAgentIds: new Set(Object.keys(controlStates)),
    });
  }, [controlStates, selection, sessions]);

  const selectSession = useCallback((agentId: string) => {
    setSelection({ agentId, kind: 'live' });
  }, [setSelection]);

  const [revealWorker, setRevealWorker] = useState<ConsoleShell['revealWorker']>(null);
  const revealSeq = useRef(0);

  /** 选中会话 +（可选）把 worker 定位请求交给当前模式 */
  const reveal = useCallback(
    (target: { agentId: string; workerId?: string }) => {
      selectSession(target.agentId);
      if (!target.workerId) return;
      revealSeq.current += 1;
      setRevealWorker({ workerId: target.workerId, requestId: revealSeq.current });
    },
    [selectSession],
  );

  const newSession = useCallback(() => {
    setSelection({ kind: 'empty' });
  }, [setSelection]);

  const openHistory = useCallback(
    (row: HistoryRow) => {
      // 已加载的历史行就是普通在跑会话，按 live 选中；否则拉磁盘预览态
      const loaded = !!controlStates[row.agentId];
      setSelection({ agentId: row.agentId, kind: loaded ? 'live' : 'history' });
      if (!loaded) void actions.loadHistory(row.agentId);
    },
    [actions, controlStates, setSelection],
  );

  /**
   * 菜单可见性的数据源与 `useAgentVM` 保持一致：**在跑的实时态优先，否则磁盘预览态**
   * （`useDisplayAgentState` 的口径）。只查 `controlStates` 的话，打开一条历史记录后
   * 头部菜单会拿 `phase: 'waiting'` 的兜底值去算暂停/停止的可见性——那是凭空捏的状态。
   */
  const menuSourceOf = useCallback(
    (agentId: string): SessionMenuSource => {
      const state =
        controlStates[agentId] ?? (historyPreview?.agentId === agentId ? historyPreview : undefined);
      return {
        phase: state?.phase ?? 'waiting',
        pendingQuestion: state?.pendingQuestion,
        children: state?.children,
        agentId: state?.agentId,
      };
    },
    [controlStates, historyPreview],
  );

  const toggleSessions = useCallback(() => setSessionsCollapsed((value) => !value), []);

  return {
    sessions,
    history,
    selectedAgentId,
    selectSession,
    newSession,
    openHistory,
    menuSourceOf,
    mode,
    setMode,
    sessionsCollapsed,
    toggleSessions,
    previewImage,
    setPreviewImage,
    revealWorker,
    reveal,
  };
}
