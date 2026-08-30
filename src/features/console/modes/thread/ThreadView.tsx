/**
 * ThreadView —— thread 中栏的装配（对应 dock 的 `DockPanel`，但**互不参照**）。
 *
 * 与 `DockPanel` 的差别不是数值，是形态：
 *
 * | | DockPanel | ThreadView |
 * |---|---|---|
 * | 外框 | 2px 边框 + 12px 圆角 + 4px 状态条 + 投影 | **无外框**，直接落在页面背景上 |
 * | 头部 | 80px 双行：图标框 + 状态徽章 + meta 轨 + token 指示器 | **一行**：标题 + `···` |
 * | cell | 共用 `ThreadCell` | 同左 |
 * | 输入 | 触发条 + 浮层 | **就地** textarea（点击只变样式，不弹浮层） |
 * | 文件操作 | 送 Dialog 里的同一个 `ReviewSlot` | **送右栏审阅面板**（带行号着色 diff） |
 *
 * 共享的只有数据层与功能块：`useTranscript` / `Transcript`（滚动容器，布局中立）/
 * `Gate` / `ImageReview` / `data/actions`。
 *
 * 上下文环固定在会话输入器主动作左侧；dev mode 只控制明细查看器入口。
 */

import { memo, useCallback, useMemo, useState } from 'react';
import { MessageSquare, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ImageNodePublicState } from '../../../../../shared/types';
import { messageText, resolvePresentationText, type PresentationText } from '@/i18n/presentationText';
import { MenuButton, type MenuItemDescriptor } from '../../chrome/MenuButton';
import { ConversationComposer } from '../../content/composer/ConversationComposer';
import { PendingEventQueue } from '../../content/composer/PendingEventQueue';
import { AgentMetricsStrip } from '../../content/AgentMetricsStrip';
import { Gate } from '../../content/Gate';
import { resolveGateRequest } from '../../content/gates/resolve';
import { useActionScope } from '../../content/useActionScope';
import { ImageReview } from '../../content/ImageReview';
import { TaskList } from '../../content/TaskList';
import { Transcript } from '../../content/Transcript';
import { useConsoleActions, type ActionTarget, type MessagePayload } from '../../data/actions';
import type { TranscriptNode, TranscriptAction } from '@/domains/transcript/nodes';
import { useTranscript } from '../../data/useTranscript';
import { isActive, type Fidelity } from '../../data/visibility';
import { activityChips, type ActivityChips } from '../../data/activity';
import {
  projectWorkerTasks,
  resolveConversationTarget,
  useAgentVM,
  useWorkerVM,
} from '../../data/vm';
import { ThreadCell } from '../../content/ThreadCell';
import { McpRuntimeCard } from '../../content/McpRuntimeCard';
import { AIRequestStatus } from '../../content/AIRequestStatus';
import styles from '../../content/thread.module.css';

export interface ThreadViewProps {
  readonly agentId: string;
  /** 有值即渲染该 worker 的 thread（父 agent 为 `agentId`） */
  readonly workerId?: string;
  readonly fidelity?: Fidelity;
  readonly devMode?: boolean;
  readonly onPreviewImage?: (src: string) => void;
  readonly imageNodes?: readonly ImageNodePublicState[];
  /** 头部 `···` 菜单（暂停 / 停止 / 打开工作区…），由模式层给 */
  readonly menuItems?: readonly MenuItemDescriptor[];
  readonly onMenuSelect?: (key: string) => void;
  /** 点文件操作条目 ⇒ 右栏审阅面板（模式层持有右栏状态，故回调由它给） */
  readonly onOpenFileChange?: (cellId: string) => void;
}

export const ThreadView = memo<ThreadViewProps>(
  ({
    agentId,
    workerId,
    fidelity = 'focused',
    devMode,
    onPreviewImage,
    imageNodes,
    menuItems,
    onMenuSelect,
    onOpenFileChange,
  }) => {
    const { t } = useTranslation();
    const active = isActive(fidelity);
    const target = useMemo<ActionTarget>(() => ({ agentId, workerId }), [agentId, workerId]);

    const agent = useAgentVM(agentId);
    const worker = useWorkerVM(workerId ? agentId : undefined, workerId);
    const actions = useConsoleActions();

    const [notice, setNotice] = useState<PresentationText | null>(null);
    const noticeText = notice
      ? resolvePresentationText(notice, (key, values) => t(key, values))
      : null;

    const transcript = useTranscript(workerId ?? agentId, {
      active,
    });

    const request = resolveConversationTarget(agent, worker, workerId);
    const subject = worker ? worker.subject : (agent?.title ?? t('sessionWorkbenchUi.shell.unnamedTask'));
    const tasks = worker
      ? projectWorkerTasks(agent?.taskBoard, worker.taskIds)
      : (agent?.taskBoard?.items ?? []);

    const gate = useMemo(
      () =>
        request
          ? resolveGateRequest({
              pendingToolCall: request.pendingToolCall,
              askUser: worker ? undefined : agent?.askUser,
            })
          : null,
      [agent?.askUser, request, worker],
    );

    const submit = useCallback(
      async (payload: MessagePayload) => {
        const result = await actions.send(target, payload);
        setNotice(result.ok
          ? null
          : result.error ?? messageText('sessionWorkbenchUi.action.sendFailed'));
        return result.ok;
      },
      [actions, target],
    );

    const interrupt = useCallback(async () => {
      const result = await actions.pause(target);
      setNotice(result.ok
        ? null
        : result.error ?? messageText('sessionWorkbenchUi.action.interruptFailed'));
    }, [actions, target]);

    const decide = useCallback(
      async (decision: Parameters<typeof actions.decide>[1]) => {
        const result = await actions.decide(target, decision);
        setNotice(result.ok
          ? null
          : result.error ?? messageText('sessionWorkbenchUi.action.operationFailed'));
      },
      [actions, target],
    );

    /**
     * 审批门的「查看详情」：待审批调用的 callId 就是那条 tool cell 的 id，
     * 直接送审阅面板看单次改动（与点已完成的编辑消息同一条链、同一套样式）。
     * 独立的 diff 预览抽屉（react-diff-viewer）已删。
     */
    const viewDiff = useCallback(() => {
      const callId = request?.pendingToolCall?.id;
      if (callId) onOpenFileChange?.(callId);
    }, [onOpenFileChange, request?.pendingToolCall?.id]);

    const runCellAction = useCallback(
      async (_cell: TranscriptNode, action: TranscriptAction) => {
        if (action.kind !== 'promote-to-background' || !action.callId) return;
        const result = await actions.promoteToBackground(action.callId);
        setNotice(result.ok
          ? null
          : result.error ?? messageText('sessionWorkbenchUi.action.promotionFailed'));
      },
      [actions],
    );

    /** `mod+b`：thread 一个 thread 一个作用域（worker tab 切换时 id 跟着变） */
    const scope = useActionScope({
      scopeId: `thread:${workerId ?? agentId}`,
      nodes: transcript.nodes,
      onAction: (cell, action) => void runCellAction(cell, action),
    });

    const renderNode = useCallback(
      (cell: TranscriptNode) => (
        <ThreadCell
          cell={cell}
          onPreviewImage={onPreviewImage}
          onOpenFileChange={onOpenFileChange}
          onAction={(target_, action) => void runCellAction(target_, action)}
        />
      ),
      [onOpenFileChange, onPreviewImage, runCellAction],
    );


    /** 当前流水的活动总量（任务清单头部的 ± 与生图） */
    const chips = useMemo(() => activityChips(transcript.nodes), [transcript.nodes]);

    /**
     * 按任务精确归属目前只对"单任务 worker"成立：
     * 它整条流水的活动就是那个任务的活动，是事实不是推断。
     * 主流水任务与多任务 worker 没有明确的工具调用任务标记，因此不做推断。
     */
    const taskChips = useMemo<ReadonlyMap<string, ActivityChips> | undefined>(() => {
      const only = worker?.taskIds.length === 1 ? worker.taskIds[0] : undefined;
      if (!only) return undefined;
      return new Map([[only, chips]]);
    }, [chips, worker]);

    if (!request) return null;

    return (
      <div className={styles.thread} {...scope}>
        {/* 头部只有一行（Codex 截图：标题 + ···，无状态徽章无 meta 轨） */}
        <div className={styles.header}>
          <span className={styles.headerIcon}>
            <MessageSquare size={14} />
          </span>
          <span className={styles.headerTitle}>{subject}</span>
          {menuItems && menuItems.length > 0 && (
            <MenuButton
              items={menuItems}
              onSelect={(key) => onMenuSelect?.(key)}
              ariaLabel={t('sessionWorkbenchUi.panels.sessionActions')}
              placement="block-end"
            >
              <MoreHorizontal size={14} />
            </MenuButton>
          )}
        </div>

        <div className={styles.center}>
            {/* 按目标重挂:切主/子 tab 时换全新滚动容器。否则 scrollTop 物理残留
                (scroll-initial-target 只救未被用户碰过的容器),上一个目标的滚动
                位置会原样带进下一个目标——用户 2026-08-25 报的"滚动条完全跟随" */}
            <Transcript
              key={workerId ?? agentId}
              memoryKey={workerId ?? agentId}
              nodes={transcript.nodes}
              renderNode={renderNode}
              hasEarlier={transcript.hasEarlier}
              onLoadEarlier={transcript.loadEarlier}
              emptyText={transcript.loaded
                ? t('sessionWorkbenchUi.transcript.emptyLoaded')
                : t('sessionWorkbenchUi.transcript.loading')}
              activeStartedAt={request.activeStartedAt}
              scrollAffordance
            />

            {/* 生图审核贴流水尾部（与门可并存） */}
            {imageNodes?.map((node) => (
              <ImageReview key={node.id} target={target} node={node} onPreviewImage={onPreviewImage} />
            ))}

        </div>

        {noticeText && <div className={styles.empty}>{noticeText}</div>}

        <AIRequestStatus request={request.request} variant={worker ? 'worker' : 'main'} />
        <McpRuntimeCard
          view={request.mcp}
          workspace={agent?.workspace}
          variant={worker ? 'worker' : 'main'}
        />

        {/* 任务清单：运行状态与输入框之间。worker 视图只看自己名下的任务。
            门在时也保留 —— 审批中同样想瞟进度 */}
        {tasks.length > 0 && agent?.taskBoard && (
          <TaskList
            taskBoard={{ taskSummary: agent.taskBoard.taskSummary, items: tasks }}
            scope={worker ? 'worker' : 'main'}
            mainAgentId={agentId}
            workers={agent.workers.map((candidate) => ({
              id: candidate.id,
              subject: candidate.subject,
            }))}
            agentId={agentId}
            chips={chips}
            taskChips={taskChips}
          />
        )}

        <PendingEventQueue events={request.pendingEvents} />

        {/* 门与输入互斥：有待决策时输入让位（与 dock 同语义，不同外观） */}
        {gate ? (
          <Gate
            request={gate}
            disabled={worker ? worker.phase === 'waiting' : request.phase === 'stopping'}
            onDecide={(decision) => void decide(decision)}
            onViewDiff={viewDiff}
            onPreviewImage={onPreviewImage}
          />
        ) : (
          <ConversationComposer
            agentId={agentId}
            workerId={workerId}
            targetName={subject}
            model={request.model}
            modeId={agent?.modeId}
            approvalMode={request.approvalMode}
            agentSpec={agent?.agentSpec}
            contextUsage={request.contextUsage}
            sourceVersion={request.conversationLength}
            contextViewerEnabled={devMode}
            canPause={request.canPause}
            stopping={request.phase === 'stopping'}
            onPreviewImage={onPreviewImage}
            onSubmit={submit}
            onInterrupt={interrupt}
          />
        )}
        <AgentMetricsStrip
          metrics={request.runMetrics}
          activeLlmStartedAt={request.activeLlmStartedAt}
          activeToolPhaseStartedAt={request.activeToolPhaseStartedAt}
        />
      </div>
    );
  },
);

ThreadView.displayName = 'ThreadView';
