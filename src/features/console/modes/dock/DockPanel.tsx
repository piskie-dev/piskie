/**
 * AgentPanel —— **一个面板，两种角色**。
 *
 * "agent 的可视化"唯一实现：主 agent 与 worker 走同一个组件，差别只在 `workerId`
 * 有没有值——不写两套头部 JSX、两种形态、两份 composer。
 *
 * 两个模式都用它：
 * - dock：主列一个（主 agent）+ 焦点槽一个（选中的 worker）
 * - thread：中栏一个（当前 agent tab 指向的那个）
 *
 * 因此它**不知道自己在哪个模式里**，也不管布局——尺寸由外部栅格给。
 *
 * 装配顺序（自上而下）：头部 → 错误条 → 流水（含生图审核贴尾）→ 运行状态 → 任务清单 → 门 / composer → 指标。
 * 门与 composer 在本层互斥，指标始终保留；**生图审核与门可并存**，所以它在 body 里贴尾。
 */

import React, { memo, useCallback, useMemo, useState } from 'react';
import { Bot, Globe, TerminalSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ImageNodePublicState } from '../../../../../shared/types';
import { ContentLinkUrlScope } from '@/components/content-links';
import { messageText, resolvePresentationText, type PresentationText } from '@/i18n/presentationText';
import { ErrorBar } from '../../chrome/ErrorBar';
import { StatusBadge } from '../../chrome/StatusBadge';
import { statusOf } from '../../chrome/statusOf';
import { useConsoleActions, type ActionTarget, type MessagePayload } from '../../data/actions';
import { useTranscript } from '../../data/useTranscript';
import { isActive, type Fidelity } from '../../data/visibility';
import {
  projectWorkerTasks,
  resolveConversationTarget,
  useAgentVM,
  useWorkerVM,
} from '../../data/vm';
import { Dialog } from '../../chrome/Dialog';
import { ConversationComposer } from '../../content/composer/ConversationComposer';
import { PendingEventQueue } from '../../content/composer/PendingEventQueue';
import { AgentMetricsStrip } from '../../content/AgentMetricsStrip';
import { Gate } from '../../content/Gate';
import { resolveGateRequest } from '../../content/gates/resolve';
import { useActionScope } from '../../content/useActionScope';
import { ImageReview } from '../../content/ImageReview';
import { McpRuntimeCard } from '../../content/McpRuntimeCard';
import { AIRequestStatus } from '../../content/AIRequestStatus';
import { Panel } from './Panel';
import { TaskList } from '../../content/TaskList';
import { Transcript } from '../../content/Transcript';
import { ThreadCell } from '../../content/ThreadCell';
import { ReviewSlot } from '../../content/ReviewSlot';
import {
  reviewTargetForPath,
  type FileReviewTarget,
} from '../../content/fileReviewTarget';
import threadStyles from '../../content/thread.module.css';
import type { TranscriptNode, TranscriptAction } from '@/domains/transcript/nodes';
import { activityChips, type ActivityChips } from '../../data/activity';

const MODE_ICON = {
  browser: Globe,
  local: TerminalSquare,
} as const;

export interface DockPanelProps {
  readonly agentId: string;
  /** 有值即渲染该 worker 的面板（父 agent 为 `agentId`） */
  readonly workerId?: string;
  readonly fidelity?: Fidelity;
  /** dev-mode 只开放上下文明细查看器；占用环始终可见 */
  readonly devMode?: boolean;
  readonly onPreviewImage?: (src: string) => void;
  /** 头部右侧动作（暂停/停止/切模式由模式层给） */
  readonly headerActions?: React.ReactNode;
  /** 待审核的生图节点（模式层从 VM 的 imageNodeIds 取全量态后传入） */
  readonly imageNodes?: readonly ImageNodePublicState[];
}

export const DockPanel = memo<DockPanelProps>(
  ({
    agentId,
    workerId,
    fidelity = 'visible',
    devMode,
    onPreviewImage,
    headerActions,
    imageNodes,
  }) => {
    const { t } = useTranslation();
    const active = isActive(fidelity);
    const target = useMemo<ActionTarget>(() => ({ agentId, workerId }), [agentId, workerId]);

    const agent = useAgentVM(agentId);
    const worker = useWorkerVM(workerId ? agentId : undefined, workerId);
    const actions = useConsoleActions();

    // 浮层开合沿用既有 uiStore 字段
    const [notice, setNotice] = useState<PresentationText | null>(null);
    const noticeText = notice
      ? resolvePresentationText(notice, (key, values) => t(key, values))
      : null;
    /** 文件操作或正文路径进入同一个 ReviewSlot；dock 只把宿主换成 Dialog。 */
    const [reviewOpen, setReviewOpen] = useState(false);
    const [reviewTarget, setReviewTarget] = useState<FileReviewTarget | undefined>(undefined);

    const transcript = useTranscript(workerId ?? agentId, {
      active,
    });

    const subject = worker ? worker.subject : (agent?.title ?? t('sessionWorkbenchUi.shell.unnamedTask'));
    const status = worker?.status ?? agent?.status;
    const request = resolveConversationTarget(agent, worker, workerId);

    const gate = useMemo(
      () =>
        request
          ? resolveGateRequest({
              pendingToolCall: request.pendingToolCall,
              // worker 结构上没有 askUser，提问门只可能出现在主面板
              askUser: worker ? undefined : agent?.askUser,
            })
          : null,
      [agent?.askUser, request, worker],
    );

    const tasks = worker
      ? projectWorkerTasks(agent?.taskBoard, worker.taskIds)
      : (agent?.taskBoard?.items ?? []);

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

    const decide = useCallback(
      async (decision: Parameters<typeof actions.decide>[1]) => {
        const result = await actions.decide(target, decision);
        setNotice(result.ok
          ? null
          : result.error ?? messageText('sessionWorkbenchUi.action.operationFailed'));
      },
      [actions, target],
    );

    const interrupt = useCallback(async () => {
      const result = await actions.pause(target);
      setNotice(result.ok
        ? null
        : result.error ?? messageText('sessionWorkbenchUi.action.interruptFailed'));
    }, [actions, target]);

    const openFileChange = useCallback((cellId: string) => {
      setReviewTarget({ kind: 'cell', cellId });
      setReviewOpen(true);
    }, []);

    const openLocalFile = useCallback(async (targetPath: string) => {
      const target_ = await reviewTargetForPath(targetPath, onPreviewImage);
      if (!target_) return;
      setReviewTarget(target_);
      setReviewOpen(true);
    }, [onPreviewImage]);

    /** 审批门的「查看详情」：callId 即 cell id，送审阅面板看单次改动 */
    const viewDiff = useCallback(() => {
      const callId = request?.pendingToolCall?.id;
      if (callId) openFileChange(callId);
    }, [openFileChange, request?.pendingToolCall?.id]);

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

    /**
     * 键盘焦点作用域：`mod+b` 转入后台。
     *
     * dock 同屏可能有多个面板（主面板 + 画布上的 worker 面板），所以作用域按面板取 id，
     * 谁最后被交互过就归谁 —— 用 `:hover` 猜归属在面板重叠或鼠标离开时就失准了。
     */
    const scope = useActionScope({
      scopeId: `dock:${workerId ?? agentId}`,
      nodes: transcript.nodes,
      onAction: (cell, action) => void runCellAction(cell, action),
    });

    const closeReview = useCallback(() => {
      setReviewOpen(false);
      setReviewTarget(undefined);
    }, []);

    /**
     * cell 呈现与 thread 同一份 `ThreadCell`：dock 节点内部也是横条阅读流，
     * 交互一致（就地展开 / 文件操作送审阅面）。
     */
    const renderNode = useCallback(
      (cell: TranscriptNode) => (
        <ThreadCell
          cell={cell}
          onPreviewImage={onPreviewImage}
          onOpenFileChange={openFileChange}
          onAction={(target_, action) => void runCellAction(target_, action)}
        />
      ),
      [onPreviewImage, openFileChange, runCellAction],
    );

    const chips = useMemo(() => activityChips(transcript.nodes), [transcript.nodes]);
    const taskChips = useMemo<ReadonlyMap<string, ActivityChips> | undefined>(() => {
      const only = worker?.taskIds.length === 1 ? worker.taskIds[0] : undefined;
      if (!only) return undefined;
      return new Map([[only, chips]]);
    }, [chips, worker]);

    if (!request) return null;

    // 锁门口径：main 看 phase==='stopping'，worker 看 phase==='waiting'
    const gateDisabled = worker ? worker.phase === 'waiting' : request.phase === 'stopping';
    const ModeIcon = worker ? (MODE_ICON[worker.mode] ?? TerminalSquare) : Bot;

    return (
      <ContentLinkUrlScope onOpenLocalFile={openLocalFile}>
      <Panel
        {...scope}
        /* `--thread-*` 变量的供给点：ThreadCell 的规则只引用这些变量（见 thread.module.css 头注） */
        className={threadStyles.skin}
        fidelity={fidelity}
        icon={<ModeIcon size={10} />}
        title={subject}
        statusTone={status ? statusOf(status).tone : undefined}
        statusPulse={status ? statusOf(status).pulse : undefined}
        status={status && <StatusBadge status={status} />}
        actions={
          headerActions
        }
        error={
          <>
            {/* 动作层的失败就地回显（动作层不认识 toast，见 data/actions） */}
            {noticeText && <ErrorBar error={{ message: noticeText }} />}
          </>
        }
        taskList={
          tasks.length > 0 && agent?.taskBoard ? (
            <TaskList
              taskBoard={{ taskSummary: agent.taskBoard.taskSummary, items: tasks }}
              scope={worker ? 'worker' : 'main'}
              mainAgentId={agentId}
              workers={agent.workers.map((candidate) => ({ id: candidate.id, subject: candidate.subject }))}
              agentId={agentId}
              chips={chips}
              taskChips={taskChips}
            />
          ) : undefined
        }
        runtime={
          <>
            <AIRequestStatus request={request.request} variant={worker ? 'worker' : 'main'} />
            <McpRuntimeCard
              view={request.mcp}
              workspace={agent?.workspace}
              variant={worker ? 'worker' : 'main'}
            />
          </>
        }
        gate={
          gate ? (
            <Gate
              request={gate}
              // 停止中 / 等待中锁门
              disabled={gateDisabled}
              onDecide={(decision) => void decide(decision)}
              onViewDiff={viewDiff}
              onPreviewImage={onPreviewImage}
            />
          ) : undefined
        }
        footer={
          <>
            <PendingEventQueue events={request.pendingEvents} />
            {!gate && (
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
          </>
        }
      >
        {/* 按目标重挂,理由同 ThreadView:固定列切换目标时滚动位置不得跨目标残留 */}
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

        {/* 统一文件审阅面；工具操作按需订阅流水，本地路径直接消费桌面预览结果。 */}
        <Dialog open={reviewOpen} onClose={closeReview} title={t('sessionWorkbenchUi.panels.reviewPanel')} width={880}>
          {reviewOpen && (
            <ReviewSlot
              agentId={agentId}
              workerId={workerId}
              target={reviewTarget}
            />
          )}
        </Dialog>

        {/* 生图审核贴在流水尾部：与门可并存，故不占 gate 槽 */}
        {imageNodes?.map((node) => (
          <ImageReview key={node.id} target={target} node={node} onPreviewImage={onPreviewImage} />
        ))}
      </Panel>
      </ContentLinkUrlScope>
    );
  },
);

DockPanel.displayName = 'DockPanel';
