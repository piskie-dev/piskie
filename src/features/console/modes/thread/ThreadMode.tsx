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
import { FolderOpen, Globe, History, Pause, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ContentLinkUrlScope } from '@/components/content-links';
import { AgentTabs, type AgentTabItem } from '../../chrome/AgentTabs';
import { Divider } from '../../chrome/Divider';
import { TopRail } from '../../chrome/TopRail';
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
import styles from './threadview.module.css';

/** 关闭集的空值；作用域为空串 ⇒ 与任何真实作用域都不相等，等价于"没关过" */
const EMPTY_CLOSED = { scope: '', panels: [] as readonly PanelKey[] } as const;

interface ScopedReviewTarget {
  readonly scope: string;
  readonly target: FileReviewTarget;
}

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
    /**
     * 被用户关掉的 tab。右栏是 tab 形态，"收起"就是"关到没有 tab"，
     * 不另设开合标志。
     *
     * **带作用域标签**：关闭是"这个视图里我不想看这一页"的意思，不该跨会话/跨 worker 生效。
     * 记住"这份关闭集属于哪个视图"，作用域一变派生自动失效——裸数组 + 在切换入口手动重置
     * 的写法迟早漏一个入口（在 A 会话关掉全部 tab，切到 B 会话右栏也是关着的）。
     */
    const [closed, setClosed] = useState<{
      readonly scope: string;
      readonly panels: readonly PanelKey[];
    }>(EMPTY_CLOSED);
    /** 用户明确打开的文件操作或正文路径；没有目标时审阅页不存在。 */
    const [reviewTarget, setReviewTarget] = useState<ScopedReviewTarget | undefined>(undefined);
    /**
     * 右栏想看哪一页。放在这里而不是 `RightPanel` 内部：`openFileOp` 要把它推到
     * 'review'，而那个入口在本组件。不可用时 `resolveSelectedPanel` 会回落，故初值随意。
     */
    const [wantedPanel, setWantedPanel] = useState<PanelKey>('review');
    /** 内嵌浏览器面板：纯手动开启——入口按钮或点流水链接 */
    const [browserOpen, setBrowserOpen] = useState(false);

    const agent = useAgentVM(selectedAgentId);
    const actions = useConsoleActions();

    // worker 销毁且正被选中 ⇒ 自动回落主会话（纯派生，不用 effect）
    const activeWorkerId = agent?.workers.some((item) => item.id === tabWorkerId) ? tabWorkerId : undefined;
    const worker = useWorkerVM(activeWorkerId ? selectedAgentId : undefined, activeWorkerId);
    const imageNodes = useImageNodes(selectedAgentId, activeWorkerId);

    /** 关闭集的作用域：一个 agent tab（主会话或某个 worker）就是一个视图。
        声明前置：openBrowser（更早定义）依赖它，后置会 TDZ */
    const panelScope = `${selectedAgentId ?? ''}|${activeWorkerId ?? ''}`;
    const activeReviewTarget = reviewTarget?.scope === panelScope ? reviewTarget.target : undefined;

    // 切换会话或 worker 后丢弃旧目标；按 scope 派生可避免清理 effect 前闪出空审阅面板。
    useEffect(() => {
      setReviewTarget((current) => (current && current.scope !== panelScope ? undefined : current));
    }, [panelScope]);

    const tabs = useMemo<readonly AgentTabItem[]>(() => {
      if (!agent) return [];
      return [
        { label: agent.title, status: agent.status },
        ...agent.workers.map((item) => ({
          workerId: item.id,
          label: item.subject,
          mode: item.mode,
          status: item.status,
        })),
      ];
    }, [agent]);

    const selectTab = useCallback((workerId?: string) => {
      setTabWorkerId(workerId);
      setReviewTarget(undefined);
      // 关闭集不用在这里重置：它带作用域标签，`panelScope` 一变就自动失效
    }, []);

    /**
     * 中栏头部的 `···` 菜单（Codex 截图里标题右侧那个）。
     * 可见性走同一份 shared 谓词（`buildSessionMenu`），与左栏行菜单同源，
     * 不另写一套 phase 判断。
     */
    const showBrowser = useCallback(() => {
      // 浏览器 tab 可能刚被关掉（进了本 scope 的关闭集）⇒ 放回来，否则整栏
      // 仍然隐藏、点链接没有直接反应（openFileChange 同款处理）
      setClosed((current) =>
        current.scope === panelScope
          ? { scope: panelScope, panels: current.panels.filter((key) => key !== 'browser') }
          : current,
      );
      setBrowserOpen(true);
      setWantedPanel('browser');
    }, [panelScope]);

    /** 打开内嵌浏览器：入口按钮（无 URL）或流水链接点击（带 URL） */
    const openBrowser = useCallback((url?: string) => {
      showBrowser();
      if (url) void window.piskie.pilot.embeddedBrowser.navigate(url);
    }, [showBrowser]);

    const openLocalHtml = useCallback(async (targetPath: string) => {
      showBrowser();
      await window.piskie.pilot.embeddedBrowser.openLocalHtml(targetPath);
    }, [showBrowser]);

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
          hasReviewTarget: activeReviewTarget !== undefined,
          hasBrowser: browserOpen,
        }),
      [activeReviewTarget, browserOpen, worker],
    );

    const closedPanels = closed.scope === panelScope ? closed.panels : EMPTY_CLOSED.panels;

    /** 扣掉用户关掉的；空数组 ⇒ 整栏不出现 */
    const visiblePanels = useMemo(
      () => allPanels.filter((key) => !closedPanels.includes(key)),
      [allPanels, closedPanels],
    );

    const showPanel = !!selectedAgentId && !!agent && visiblePanels.length > 0;

    const closePanel = useCallback(
      (key: PanelKey) => {
        setClosed((current) => {
          const base = current.scope === panelScope ? current.panels : [];
          if (base.includes(key)) return current;
          return { scope: panelScope, panels: [...base, key] };
        });
        // 关审阅页时必须同时清目标：目标本身会让审阅 tab 可用，不清就关不掉
        if (key === 'review') setReviewTarget(undefined);
        // 浏览器面板是全局手动态：关 tab 即全局关闭（视图隐藏、页面状态保留）
        if (key === 'browser') setBrowserOpen(false);
      },
      [panelScope],
    );

    const showReviewTarget = useCallback(
      (target: FileReviewTarget) => {
        // 审阅页可能刚被关掉 ⇒ 放回来，否则点条目没反应
        setClosed((current) =>
          current.scope === panelScope
            ? { scope: panelScope, panels: current.panels.filter((key) => key !== 'review') }
            : current,
        );
        setReviewTarget({ scope: panelScope, target });
        setWantedPanel('review');
      },
      [panelScope],
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

          <TopRail actions={showPanel ? undefined : topRailActions}>
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
              agentId={selectedAgentId}
              worker={worker}
              panels={visiblePanels}
              onClosePanel={closePanel}
              wanted={wantedPanel}
              onPick={setWantedPanel}
              reviewTarget={activeReviewTarget}
              topRailActions={topRailActions}
            />
          )}
        </div>
      </div>
      </ContentLinkUrlScope>
    );
  },
);

ThreadMode.displayName = 'ThreadMode';
