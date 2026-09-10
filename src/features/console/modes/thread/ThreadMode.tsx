/**
 * ThreadMode —— 线程视图模式。
 *
 * 没有画布、没有节点、没有连线、没有缩放：左栏会话树 + 中栏阅读流 + 右栏 tab。
 *
 * 与 dock 模式不共享布局；两者复用 data/content 层与顶部导航标签，
 * 线程视图仍独立负责中栏阅读流和右栏内容。
 *
 * 一次选择三处联动：agent tab 决定中栏 transcript、composer 投递目标、右栏内容。
 * worker 销毁且正被选中时**自动回落主会话 tab**——纯派生（选中 id 不在 workers 里就
 * 视为主会话），不用 effect 纠正。
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Globe, History, PanelRightClose, PanelRightOpen, Pause, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ContentLinkUrlScope } from '@/components/content-links';
import { AgentTabs, type AgentTabItem } from '../../chrome/AgentTabs';
import { Divider } from '../../chrome/Divider';
import { TopRail } from '../../chrome/TopRail';
import { Tooltip } from '../../chrome/Tooltip';
import type { MenuItemDescriptor } from '../../chrome/MenuButton';
import { ThreadSidebar } from '../../content/ThreadSidebar';
import {
  reviewTargetForPath,
  type FileReviewTarget,
} from '../../content/fileReviewTarget';
import { ThreadView } from './ThreadView';
import { useConsoleActions } from '../../data/actions';
import { useImageNodes } from '../../data/useImageNodes';
import type { HistoryRow, SessionRow } from '../../data/sessionRow';
import { buildSessionMenu, type SessionMenuSource } from '../../data/sessionMenu';
import { useGlobalBinding } from '../../data/useKeyboard';
import { useAgentVM, useWorkerVM } from '../../data/vm';
import { RightPanel } from './RightPanel';
import { availablePanels, type PanelKey } from './panels';
import { useEmbeddedBrowserState } from './useEmbeddedBrowserState';
import { useThreadPanels } from './useThreadPanels';
import styles from './threadview.module.css';

export interface ThreadModeProps {
  readonly sessions: readonly SessionRow[];
  readonly history: readonly HistoryRow[];
  readonly selectedAgentId: string | null;
  readonly onSelectSession: (agentId: string) => void;
  readonly onSelectHistory: (row: HistoryRow) => void;
  readonly menuSourceOf: (agentId: string) => SessionMenuSource;
  readonly devMode?: boolean;
  readonly onNewSession?: () => void;
  readonly onNewSessionIn?: (workspace?: string) => void;
  /** 打开创建/配置任务弹层（与 dock 侧栏底部的「启动任务」同一入口） */
  readonly onStartTask?: () => void;
  /** 与 dock 共用同一份壳级状态，保证切模式时左栏宽度不变（52 / 240） */
  readonly sessionsCollapsed: boolean;
  readonly onToggleSessions: () => void;
  /**
   * 顶栏徽标的 worker 级定位请求（一次性）。`requestId` 变化即消费一次 ——
   * 只比对 workerId 会漏掉"同一 worker 连续 reveal 两次"。
   */
  readonly revealWorker?: { readonly workerId: string; readonly requestId: number } | null;
  readonly topRailActions?: React.ReactNode;
  readonly emptyState: React.ReactNode;
  readonly onPreviewImage?: (src: string) => void;
}

export const ThreadMode = memo<ThreadModeProps>(
  ({
    sessions,
    history,
    selectedAgentId,
    onSelectSession,
    onSelectHistory,
    menuSourceOf,
    devMode,
    onNewSession,
    onNewSessionIn,
    onStartTask,
    sessionsCollapsed,
    onToggleSessions,
    emptyState,
    onPreviewImage,
    revealWorker,
    topRailActions,
  }) => {
    const { t } = useTranslation();
    const gridRef = useRef<HTMLDivElement>(null);
    const threadsRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [tabWorkerId, setTabWorkerId] = useState<string | undefined>(undefined);

    /** 顶栏 worker 定位请求 ⇒ 切到那个 tab（判据是 requestId，理由同 dock 侧注释） */
    const consumedReveal = useRef<number | null>(null);
    useEffect(() => {
      if (!revealWorker || consumedReveal.current === revealWorker.requestId) return;
      consumedReveal.current = revealWorker.requestId;
      setTabWorkerId(revealWorker.workerId);
    }, [revealWorker]);
    const agent = useAgentVM(selectedAgentId);
    const actions = useConsoleActions();

    // worker 销毁且正被选中 ⇒ 自动回落主会话（纯派生，不用 effect）
    const activeWorkerId = agent?.workers.some((item) => item.id === tabWorkerId) ? tabWorkerId : undefined;
    const worker = useWorkerVM(activeWorkerId ? selectedAgentId : undefined, activeWorkerId);
    const imageNodes = useImageNodes(selectedAgentId, activeWorkerId);

    const panelScope = `${selectedAgentId ?? ''}|${activeWorkerId ?? ''}`;
    const browserTarget = useMemo(() => selectedAgentId
      ? { agentId: selectedAgentId, workerId: activeWorkerId }
      : undefined, [activeWorkerId, selectedAgentId]);
    const browserState = useEmbeddedBrowserState(browserTarget);
    const panelView = useThreadPanels(panelScope);
    const { open: openPanel, close: closePanelView } = panelView;

    const tabs = useMemo<readonly AgentTabItem[]>(() => {
      if (!agent) return [];
      return [
        { label: agent.title, status: agent.status },
        ...agent.workers.map((item) => ({
          workerId: item.id,
          label: item.subject,
          type: item.type,
          status: item.status,
        })),
      ];
    }, [agent]);

    const selectTab = useCallback((workerId?: string) => {
      setTabWorkerId(workerId);
    }, []);

    /** 打开内嵌浏览器：入口按钮（无 URL）或流水链接点击（带 URL） */
    const openBrowser = useCallback(async (url?: string) => {
      if (!browserTarget) return;
      openPanel('browser');
      const api = window.piskie.pilot.embeddedBrowser;
      if (url) await api.navigate(browserTarget, url);
      else await api.open(browserTarget);
    }, [browserTarget, openPanel]);

    const openLocalHtml = useCallback(async (targetPath: string) => {
      if (!browserTarget) return;
      openPanel('browser');
      await window.piskie.pilot.embeddedBrowser.openLocalHtml(browserTarget, targetPath);
    }, [browserTarget, openPanel]);

    const threadMenu = useMemo(() => {
      if (!selectedAgentId) return [];
      const icons: Record<string, React.ReactNode> = {
        workspace: <FolderOpen size={12} />,
        trace: <History size={12} />,
        pause: <Pause size={12} />,
        stop: <Square size={12} />,
      };
      const items: Array<MenuItemDescriptor> = buildSessionMenu(menuSourceOf(selectedAgentId)).map((item) => ({
        ...item,
        label: t(`sessionWorkbenchUi.sessionMenu.${item.key === 'workspace' ? 'openWorkspace' : item.key === 'trace' ? 'viewTrace' : item.key}`),
        icon: icons[item.key],
      }));
      // 内嵌浏览器手动入口：人驱动干净浏览器，也可点流水链接直达
      items.push({
        key: 'embedded-browser',
        label: t('sessionWorkbenchUi.browser.embeddedBrowser'),
        icon: <Globe size={12} />,
      });
      return items;
    }, [menuSourceOf, selectedAgentId, t]);

    const onThreadMenu = useCallback(
      (key: string) => {
        if (!selectedAgentId || !agent) return;
        if (key === 'workspace') void actions.openWorkspace(agent.workspace);
        else if (key === 'trace') void actions.openTrace(agent.agentId);
        else if (key === 'pause') void actions.pause({ agentId: selectedAgentId, workerId: activeWorkerId });
        else if (key === 'stop') void actions.stop(selectedAgentId);
        else if (key === 'embedded-browser') openBrowser();
      },
      [actions, activeWorkerId, agent, openBrowser, selectedAgentId],
    );

    /**
     * 可用 tab 全集（有内容才有 tab，见 `panels.ts`）。
     * 审阅只在用户点开文件操作或正文路径后出现；历史改动本身不会主动展开右栏。
     */
    const allPanels = useMemo(
      () =>
        availablePanels({
          isWorker: !!worker,
          hasScreen: !!worker?.browserId,
          hasReviewTarget: panelView.reviewTarget !== undefined,
          hasBrowser: browserState.open,
        }),
      [panelView.reviewTarget, browserState.open, worker],
    );

    /** 扣掉用户关掉的；空数组 ⇒ 整栏不出现 */
    const visiblePanels = useMemo(
      () => allPanels.filter((key) => !panelView.closed.includes(key)),
      [allPanels, panelView.closed],
    );

    const showPanel = !!browserTarget && !!agent && !panelView.collapsed && visiblePanels.length > 0;

    const closePanel = useCallback(
      (key: PanelKey) => {
        closePanelView(key);
        if (key === 'browser' && browserTarget) {
          void window.piskie.pilot.embeddedBrowser.close(browserTarget);
        }
      },
      [browserTarget, closePanelView],
    );

    const showReviewTarget = useCallback(
      (target: FileReviewTarget) => openPanel('review', target),
      [openPanel],
    );

    const openFileChange = useCallback(
      (cellId: string) => showReviewTarget({ kind: 'cell', cellId }),
      [showReviewTarget],
    );

    const openLocalFile = useCallback(async (targetPath: string) => {
      const target = await reviewTargetForPath(targetPath, onPreviewImage);
      if (target) showReviewTarget(target);
    }, [onPreviewImage, showReviewTarget]);

    const backToMain = useCallback(() => setTabWorkerId(undefined), []);

    // Esc 链的第三级：回到主会话 tab。未选中 worker 时不注册
    useGlobalBinding('escape', t('sessionWorkbenchUi.panels.backToMain'), backToMain, !!activeWorkerId);

    const railActions = (
      <>
        {topRailActions}
        {selectedAgentId && agent && (
          <Tooltip title={t(showPanel ? 'sessionWorkbenchUi.panels.collapse' : 'sessionWorkbenchUi.panels.expand')}>
            <button
              type="button"
              className={styles.panelToggle}
              aria-label={t(showPanel ? 'sessionWorkbenchUi.panels.collapse' : 'sessionWorkbenchUi.panels.expand')}
              aria-expanded={showPanel}
              onClick={() => {
                if (showPanel) panelView.collapse();
                else if (visiblePanels.length > 0) panelView.expand();
                else if (allPanels[0]) openPanel(allPanels[0]);
                else void openBrowser();
              }}
            >
              {showPanel ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            </button>
          </Tooltip>
        )}
      </>
    );

    return (
      <ContentLinkUrlScope
        onOpenUrl={openBrowser}
        onOpenLocalHtml={openLocalHtml}
        onOpenLocalFile={openLocalFile}
      >
      <div
        ref={gridRef}
        className={styles.threadview}
        data-panel-hidden={showPanel ? undefined : 'true'}
        data-empty={!selectedAgentId || !agent ? 'true' : undefined}
        data-threads-collapsed={sessionsCollapsed ? 'true' : undefined}
      >
        <div ref={threadsRef} className={styles.threads}>
          {/* 左栏整体（收起态/顶栏/会话树）在共享的 ThreadSidebar，与 dock 同一份 */}
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
        </div>

        <div className={styles.center}>
          {!sessionsCollapsed && (
          <div className={styles.dividerStart}>
            <Divider
              cssVar="--col-threads"
              targetRef={gridRef}
              measureRef={threadsRef}
              defaultValue="240px"
              min={200}
              max={420}
              ariaLabel={t('sessionWorkbenchUi.panels.resizeSidebar')}
            />
          </div>
          )}

          <TopRail actions={showPanel ? undefined : railActions}>
            {selectedAgentId && agent && (
              <AgentTabs items={tabs} selectedWorkerId={activeWorkerId} onSelect={selectTab} />
            )}
          </TopRail>

          {/* 阅读列居中定宽；空态与活跃态共用同一容器 ⇒ composer 零位移 */}
          <div className={styles.column}>
            {selectedAgentId && agent ? (
              <ThreadView
                agentId={selectedAgentId}
                workerId={activeWorkerId}
                fidelity="focused"
                devMode={devMode}
                onPreviewImage={onPreviewImage}
                imageNodes={imageNodes}
                menuItems={threadMenu}
                onMenuSelect={onThreadMenu}
                onOpenFileChange={openFileChange}
              />
            ) : emptyState}
          </div>

          {showPanel && (
          <div className={styles.dividerEnd}>
            <Divider
              cssVar="--col-panel"
              targetRef={gridRef}
              measureRef={panelRef}
              // 右栏在分隔条右侧：往右拖是变窄（不加这条方向就反了）
              pane="trailing"
              defaultValue="38%"
              min={280}
              /* 上限给到 1100：中栏有 360px 硬下限兜底（见 threadview.module.css 的
                 栅格注释），窗口装不下时右栏会被自动压回，所以这里不必按窗口宽度算 */
              max={1100}
              ariaLabel={t('sessionWorkbenchUi.panels.resizeAuxiliary')}
            />
          </div>
          )}
        </div>

        <div ref={panelRef} className={styles.panel} data-collapsed={showPanel ? undefined : 'true'}>
          {showPanel && (
            <RightPanel
              agentId={browserTarget.agentId}
              worker={worker}
              panels={visiblePanels}
              onClosePanel={closePanel}
              wanted={panelView.wanted}
              onPick={panelView.pick}
              reviewTarget={panelView.reviewTarget}
              browserState={browserState}
              browserTarget={browserTarget}
              topRailActions={railActions}
            />
          )}
        </div>
      </div>
      </ContentLinkUrlScope>
    );
  },
);

ThreadMode.displayName = 'ThreadMode';
