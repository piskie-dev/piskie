/**
 * DockMode —— 工作台模式。
 *
 * 这个文件**只做装配**：把栅格槽位填上组件，把选中态串起来。
 * 面板本身是共用的 `content/AgentPanel`（主 agent 与 worker 同一个组件）。
 *
 * 与 thread 模式不共享布局；两者只复用 data/content 层与顶部导航标签。
 * 这里的 grid 仍只服务 dock 的画布视觉。
 *
 * 保真度：未选中 worker 时焦点槽与辅助槽不挂载（栅格直接收成两列）；
 * 主面板恒为 `focused`（dock 模式下主列一直可见）。
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AgentTabs, type AgentTabItem } from '../../chrome/AgentTabs';
import { Divider } from '../../chrome/Divider';
import { TopRail } from '../../chrome/TopRail';
import { BrowserScreenView } from '../../content/ScreenView';
import { DockPanel } from './DockPanel';
import { ScreenFullscreen, type ScreenFullscreenTarget } from '../../content/ScreenFullscreen';
import { ThreadSidebar } from '../../content/ThreadSidebar';
import type { HistoryRow, SessionRow } from '../../data/session';
import type { SessionMenuSource } from '../../data/sessionMenu';
import { useGlobalBinding } from '../../data/useKeyboard';
import { useImageNodes } from '../../data/useImageNodes';
import { useAgentVM, useWorkerVM } from '../../data/vm';
import { DockCanvas } from './canvas/DockCanvas';
import { useCanvasWorkers } from './canvas/useCanvasWorkers';
import styles from './workbench.module.css';

export interface DockModeProps {
  readonly sessions: readonly SessionRow[];
  readonly history: readonly HistoryRow[];
  readonly selectedAgentId: string | null;
  readonly onSelectSession: (agentId: string) => void;
  readonly onSelectHistory: (row: HistoryRow) => void;
  readonly menuSourceOf: (agentId: string) => SessionMenuSource;
  readonly sessionsCollapsed: boolean;
  readonly onToggleSessions: () => void;
  readonly devMode?: boolean;
  readonly onNewSession?: () => void;
  readonly onNewSessionIn?: (workspace?: string) => void;
  readonly onStartTask?: () => void;
  /** 空态用（logo / tagline / tip / 模板卡片 + composer 插槽） */
  /**
   * 顶栏徽标的 worker 级定位请求（一次性）。`requestId` 变化即消费一次 ——
   * 只比对 workerId 会漏掉"同一 worker 连续 reveal 两次"。
   */
  readonly revealWorker?: { readonly workerId: string; readonly requestId: number } | null;
  readonly topRailActions?: React.ReactNode;
  readonly emptyState: React.ReactNode;
  readonly onPreviewImage?: (src: string) => void;
}

export const DockMode = memo<DockModeProps>(
  ({
    sessions,
    history,
    selectedAgentId,
    onSelectSession,
    onSelectHistory,
    menuSourceOf,
    sessionsCollapsed,
    onToggleSessions,
    devMode,
    onNewSession,
    onNewSessionIn,
    onStartTask,
    emptyState,
    onPreviewImage,
    revealWorker,
    topRailActions,
  }) => {
    const { t } = useTranslation();
    const gridRef = useRef<HTMLDivElement>(null);
    const mainColRef = useRef<HTMLDivElement>(null);
    const [focusWorkerId, setFocusWorkerId] = useState<string | null>(null);
    const [fullscreen, setFullscreen] = useState<ScreenFullscreenTarget | null>(null);

    /**
     * 消费顶栏的 worker 定位请求：选中它，等于 reveal。
     *
     * 以 `requestId` 为判据而不是 workerId —— 同一个 worker 再次待确认时也要再选一次。
     * 这是"外部一次性请求 → 本地选中态"的同步，不是把状态所有权交出去。
     */
    const consumedReveal = useRef<number | null>(null);
    useEffect(() => {
      if (!revealWorker || consumedReveal.current === revealWorker.requestId) return;
      consumedReveal.current = revealWorker.requestId;
      setFocusWorkerId(revealWorker.workerId);
    }, [revealWorker]);

    const agent = useAgentVM(selectedAgentId);
    const worker = useWorkerVM(selectedAgentId, focusWorkerId);
    const mainImageNodes = useImageNodes(selectedAgentId);
    const workerImageNodes = useImageNodes(selectedAgentId, worker?.id);

    const tabs = useMemo<readonly AgentTabItem[]>(() => {
      if (!agent) return [];
      return [
        { label: agent.title, status: agent.status, selectable: false },
        ...agent.workers.map((candidate) => ({
          workerId: candidate.id,
          label: candidate.subject,
          mode: candidate.mode,
          status: candidate.status,
        })),
      ];
    }, [agent]);

    const selectWorker = useCallback((id?: string) => {
      if (!id) return;
      // 再点一次取消选中
      setFocusWorkerId((current) => (current === id ? null : id));
    }, []);

    const clearFocus = useCallback(() => setFocusWorkerId(null), []);

    // Esc 链的第三级：清除 worker 选中（回主会话）。没有选中就不注册，
    // 让 Esc 自然落到"无动作"——不做「中断 agent」，避免误触
    useGlobalBinding('escape', t('sessionWorkbenchUi.panels.clearWorkerSelection'), clearFocus, !!focusWorkerId);

    /**
     * 画布上的 worker：**未被固定列占用的那些**。
     * 没选中时全部上画布，因此不点也能看到每个 worker 及其附属。
     */
    const allCanvasWorkers = useCanvasWorkers(selectedAgentId);
    const canvasWorkers = useMemo(
      () => allCanvasWorkers.filter((candidate) => candidate.id !== focusWorkerId),
      [allCanvasWorkers, focusWorkerId],
    );

    const hasFocus = !!worker;
    // 协作者标签只在有 worker 时出现。
    const hasWorkers = (agent?.workers.length ?? 0) > 0;

    // 辅助槽目前只有屏幕一种
    const hasScreen = !!worker?.browserId && worker.mode !== 'local';

    return (
      <div
        ref={gridRef}
        className={styles.dock}
        data-sessions-collapsed={sessionsCollapsed ? 'true' : undefined}
      >
        {/* 左栏：全高兄弟节点。内容与 thread 完全一致，
            走共享的 ThreadSidebar（搜索 + `+` 菜单 + 在跑/历史合并的工作区树） */}
        <aside className={styles.sessions}>
          <ThreadSidebar
            sessions={sessions}
            history={history}
            selectedAgentId={selectedAgentId}
            collapsed={sessionsCollapsed}
            onToggleCollapsed={onToggleSessions}
            onSelectSession={onSelectSession}
            onSelectHistory={onSelectHistory}
            menuSourceOf={menuSourceOf}
            onNewSession={onNewSession}
            onNewSessionIn={onNewSessionIn}
            onStartTask={onStartTask}
          />
        </aside>

        <div className={styles.work}>
          {/* 无会话时空态**占满整个工作区**，不进主列 */}
          {!selectedAgentId || !agent ? (
            <>
              <TopRail actions={topRailActions} />
              <div className={styles.emptySlot}>{emptyState}</div>
            </>
          ) : (
            <>
              <TopRail actions={topRailActions}>
                {hasWorkers && (
                  <AgentTabs
                    items={tabs}
                    selectedWorkerId={focusWorkerId ?? undefined}
                    onSelect={selectWorker}
                  />
                )}
              </TopRail>

              <div className={styles.stage}>
                {/* 主列：恒定窄列（26% / 520 上限），不随有无 worker 变宽 */}
                <div ref={mainColRef} className={styles.mainCol}>
                  <div className={styles.dividerMain}>
                    <Divider
                      cssVar="--col-main"
                      targetRef={gridRef}
                      measureRef={mainColRef}
                      defaultValue="clamp(260px, 26%, 520px)"
                      min={260}
                      max={520}
                      ariaLabel={t('sessionWorkbenchUi.panels.resizePrimary')}
                    />
                  </div>

                  <div className={styles.panel}>
                    <DockPanel
                      agentId={selectedAgentId}
                      fidelity="focused"
                      devMode={devMode}
                      onPreviewImage={onPreviewImage}
                      imageNodes={mainImageNodes}
                    />
                  </div>
                </div>

                {/* 选中 worker：同宽度带的一列，辅助行在**该列底部**（不横跨主列） */}
                {hasFocus && worker && (
                  <div className={styles.subCol}>
                    <div className={styles.subPanel}>
                      <div className={styles.panel}>
                        <DockPanel
                          agentId={selectedAgentId}
                          workerId={worker.id}
                          fidelity="visible"
                          devMode={devMode}
                          onPreviewImage={onPreviewImage}
                          imageNodes={workerImageNodes}
                        />
                      </div>
                    </div>

                    {hasScreen && (
                      <div className={styles.subAux}>
                        <div className={styles.auxSlot}>
                          <BrowserScreenView
                            subagentId={worker.id}
                            browserId={worker.browserId as string}
                            browserReady={worker.browserReady}
                            title={worker.subject}
                            onFullscreen={() =>
                              setFullscreen({
                                browserId: worker.browserId as string,
                                subagentId: worker.id,
                                title: worker.subject,
                              })
                            }
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 主列右侧：节点画布 */}
                <div className={styles.rest}>
                  <DockCanvas
                    agentId={selectedAgentId}
                    workers={canvasWorkers}
                    stopping={agent.phase === 'stopping'}
                    devMode={devMode}
                    onPreviewImage={onPreviewImage}
                    onFullscreen={(target) => setFullscreen(target)}
                    emptyHint={
                      (agent.workers.length ?? 0) === 0
                        ? t('sessionWorkbenchUi.panels.noCollaborators')
                        : t('sessionWorkbenchUi.panels.collaboratorHint')
                    }
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {fullscreen && (
          <ScreenFullscreen
            open
            onClose={() => setFullscreen(null)}
            {...fullscreen}
          />
        )}
      </div>
    );
  },
);

DockMode.displayName = 'DockMode';
