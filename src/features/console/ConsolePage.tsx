/**
 * ConsolePage —— 控制台页面壳
 *
 * 终态职责**只有三样**：
 * 1. 模式切换胶囊（`chrome/ModeSwitch`）
 * 2. 创建入口（`shell/TaskDefinitionLauncher` + `TaskDefinitionModal`）
 * 3. 全局 overlay（截图预览）
 *
 * 壳拥有顶栏操作，但由当前模式把它放进实际处于右边缘的顶栏轨道。
 * 左栏、空态、worker 导航仍全部下沉到模式内。
 *
 * `TaskDefinitionModal` 与"当前在看哪个会话"无关，且被 Settings 的
 * `ConnectionEditorModal` 共用——属页面级共享件，
 * 不是控制台渲染树的一部分。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import logo128 from '/logo-128.png';
import type { ApprovalMode } from '../../../shared/types';
import type { TaskDefinitionSnapshot } from '../../../shared/electron-contracts/task-definitions';
import { TaskDefinitionModal } from '../../components/task-definition/TaskDefinitionModal';
import ImageLightbox from './content/ImageLightbox';
import { useComposerDraft } from './data/composer-drafts';
import { acquireOverlay } from './chrome/overlayPresence';
import {
  useRendererRuntime,
  useTaskDefinitionRepository,
} from '../../renderer-runtime/hooks';
import { formatModelReference, useInferenceStore } from '../../store/inferenceStore';
import {
  messageText,
  presentationFromError,
  rawText,
  resolvePresentationText,
  type PresentationText,
} from '../../i18n/presentationText';
import { composeAttachmentText, useAttachmentDraft } from './attachments';
import { ErrorBar } from './chrome/ErrorBar';
import { ModeSwitch } from './chrome/ModeSwitch';
import { EmptyState } from './content/EmptyState';
import { WelcomeComposer } from './content/composer/WelcomeComposer';
import { McpRuntimeCard } from './content/McpRuntimeCard';
import { useDevelopmentFeatures } from './data/useDevelopmentFeatures';
import { useMcpPrewarm } from './data/useMcpPrewarm';
import { TaskDefinitionLauncher } from './shell/TaskDefinitionLauncher';
import { useConsoleKeyboard } from './shell/useConsoleKeyboard';
import { useConsoleShell } from './shell/useConsoleShell';
import { useHeaderAction } from './shell/useHeaderAction';
import { useAgentStart, type QuickChatOptions, type StartOutcome } from './shell/useAgentStart';
import { ThreadMode } from './modes/thread/ThreadMode';
import { DockMode } from './modes/dock/DockMode';
import styles from './shell/shell.module.css';

/**
 * 空态的输入器：还没有会话，投递即"新建并启动"。
 *
 * 位置贴底，这是不变量。
 * 模型 / 计划模式 / 审批模式 / 工作区 / 浏览器环境都在这里选 ——
 * 启动后它们固化进 runConfig，活跃态的 dock 触发条里不再可改。
 */
const WelcomeInput: React.FC<{
  readonly sending: boolean;
  readonly onStart: (text: string, options: QuickChatOptions) => Promise<StartOutcome>;
  readonly onPreviewImage?: (src: string) => void;
  /** 左栏组头「在此工作区新建会话」的预选目录:每次点击都是新对象,重复点同一组也会重新套用 */
  readonly workspaceSeed?: { readonly path?: string } | null;
}> = ({ sending, onStart, onPreviewImage, workspaceSeed }) => {
  const { t } = useTranslation();
  // 草稿驻留:切模块/切会话回来文字仍在(composer-drafts)
  const [draft, setDraft] = useComposerDraft('welcome');
  const [modeId, setMode] = useState<'normal' | 'plan' | 'browser-skill'>('normal');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('confirm');
  const [model, setModel] = useState<string | undefined>();
  const [workspace, setWorkspace] = useState<string | undefined>();
  const [environmentIds, setEnvironmentIds] = useState<string[]>([]);
  const attachments = useAttachmentDraft('welcome');
  const submitting = useRef(false);

  // 套用左栏的预选目录(对象身份即触发信号)
  /* eslint-disable react-hooks/set-state-in-effect -- 外部预选目录的一次性套用 */
  useEffect(() => {
    if (workspaceSeed) setWorkspace(workspaceSeed.path);
  }, [workspaceSeed]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const inferenceSelections = useInferenceStore((store) => store.selections);
  const mcpPrewarmEnabled = modeId !== 'browser-skill';
  const prewarmRequest = useMemo(
    () => (mcpPrewarmEnabled ? { workspace, specName: 'system-chat' } : null),
    [mcpPrewarmEnabled, workspace],
  );
  const prewarm = useMcpPrewarm(prewarmRequest);

  /** 未显式选择时跟随统一 Inference 控制面的当前模型。 */
  const resolvedModel = useMemo(() => {
    if (model !== undefined) return model;
    return inferenceSelections?.ai ? formatModelReference(inferenceSelections.ai) : undefined;
  }, [inferenceSelections, model]);

  const workspaceLabel = useMemo(() => {
    if (!workspace) return t('sessionWorkbenchUi.shell.defaultWorkspace');
    const segments = workspace.replace(/\\/g, '/').split('/').filter(Boolean);
    return segments.at(-1) || workspace;
  }, [t, workspace]);

  const selectWorkspace = useCallback(async () => {
    const paths = await window.piskie.desktop.files.select({ type: 'folder' });
    if (paths[0]) setWorkspace(paths[0]);
  }, []);

  const submit = useCallback(async () => {
    if (submitting.current || (!draft.trim() && !attachments.hasAttachments)) return;
    submitting.current = true;
    try {
      const text = composeAttachmentText(draft, attachments.files, attachments.images.length > 0);
      const images = await attachments.imagePayloads();
      const mcpPrewarmToken = prewarm.claim();
      const outcome = await onStart(text, {
        workspace,
        model: resolvedModel,
        modeId,
        approvalMode,
        environmentIds,
        images,
        mcpPrewarmToken,
      });
      prewarm.settle(mcpPrewarmToken, outcome.kind === 'started');
      if (outcome.kind === 'started') {
        setDraft('');
        setEnvironmentIds([]);
        attachments.clear();
      }
    } finally {
      submitting.current = false;
    }
  }, [approvalMode, attachments, draft, environmentIds, onStart, modeId, prewarm, resolvedModel, setDraft, workspace]);

  return (
    <WelcomeComposer
      value={draft}
      onChange={setDraft}
      onSubmit={submit}
      onPaste={attachments.handlePaste}
      placeholder={modeId === 'browser-skill'
        ? t('sessionWorkbenchUi.shell.describeWebsiteSkill')
        : t('sessionWorkbenchUi.shell.describeTask')}
      sending={sending}
      images={attachments.images}
      files={attachments.files}
      onRemoveAttachment={attachments.remove}
      onPreviewImage={onPreviewImage}
      model={resolvedModel}
      onModelChange={setModel}
      modeId={modeId}
      onModeChange={(nextMode) => {
        if (nextMode === 'normal' || nextMode === 'plan' || nextMode === 'browser-skill') {
          setMode(nextMode);
        }
      }}
      approvalMode={approvalMode}
      onApprovalModeChange={setApprovalMode}
      workspaceLabel={workspaceLabel}
      workspacePath={workspace}
      onSelectWorkspace={() => void selectWorkspace()}
      onUseDefaultWorkspace={() => setWorkspace(undefined)}
      environmentIds={environmentIds}
      onEnvironmentIdsChange={setEnvironmentIds}
      statusSlot={(
        <McpRuntimeCard
          view={prewarm.view}
          error={prewarm.error}
          workspace={workspace}
          variant="composer"
        />
      )}
    />
  );
};

const ConsoleShellView: React.FC = () => {
  const { t } = useTranslation();
  const shell = useConsoleShell();
  const hasActiveSession = shell.selectedAgentId !== null;
  const renderedMode = hasActiveSession ? shell.mode : 'thread';
  const devMode = useDevelopmentFeatures();
  const runtime = useRendererRuntime();
  const taskDefinitions = useTaskDefinitionRepository((store) => store.definitions);
  const taskDefinitionError = useTaskDefinitionRepository((store) => store.error);

  useEffect(() => {
    void runtime.taskDefinitions.refresh();
  }, [runtime]);

  /**
   * 浮层在场登记（z-order 协调）：内嵌浏览器的 WebContentsView 恒浮在页面
   * 内容之上，这些弹层出现时它必须让位（BrowserPanel 订阅计数自行隐藏）。
   * ConsolePage 是这些浮层的共同宿主，登记收口在此一处。
   */
  useEffect(() => (shell.previewImage ? acquireOverlay() : undefined), [shell.previewImage]);

  const [taskEditor, setTaskEditor] = useState<
    { readonly kind: 'create' }
    | { readonly kind: 'edit'; readonly definition: TaskDefinitionSnapshot }
    | null
  >(null);

  // 浮层在场登记：任务模板编辑弹窗要让内嵌浏览器视图让位。
  useEffect(() => (taskEditor ? acquireOverlay() : undefined), [taskEditor]);
  const [starting, setStarting] = useState(false);
  /**
   * 启动失败的可见反馈。四个入口（空态卡片、任务模板启动器、创建弹层的"创建并启动"、
   * 快速聊天）都必须处理各自 `StartOutcome` 的 `failed` 分支；错误归属发起操作，
   * 丢掉它就等于"点了卡片什么都没发生"且没有任何线索。
   */
  const [startError, setStartError] = useState<PresentationText | null>(null);
  const visibleError = startError
    ? resolvePresentationText(startError, (key, values) => t(key, values))
    : taskDefinitionError;

  const deleteTaskDefinition = useCallback(async (definitionId: string) => {
    try {
      await runtime.taskDefinitions.delete(definitionId);
    } catch (error) {
      setStartError(presentationFromError(
        error,
        messageText('sessionWorkbenchUi.shell.deleteTemplateFailed'),
      ));
    }
  }, [runtime]);

  const agentStart = useAgentStart(shell.selectSession);

  /** 四个入口共用的收尾：failed 出错误条，started 什么都不用做。 */
  const settle = useCallback((outcome: StartOutcome) => {
    if (outcome.kind === 'failed') {
      setStartError(outcome.error
        ? rawText(outcome.error)
        : messageText(outcome.reason === 'empty-content'
            ? 'sessionWorkbenchUi.shell.emptyContent'
            : 'sessionWorkbenchUi.shell.launchFailed'));
    }
  }, []);

  /** 三个入口共用：启动一个模板。 */
  const launch = useCallback(
    async (definition: TaskDefinitionSnapshot) => {
      setStarting(true);
      setStartError(null);
      try {
        settle(await agentStart.startTaskDefinition(definition));
      } catch (error) {
        setStartError(presentationFromError(
          error,
          messageText('sessionWorkbenchUi.shell.launchFailed'),
        ));
      } finally {
        setStarting(false);
      }
    },
    [agentStart, settle],
  );

  const quickChat = useCallback(
    async (text: string, options: QuickChatOptions) => {
      setStarting(true);
      setStartError(null);
      try {
        const outcome = await agentStart.startQuickChat(text, options);
        settle(outcome);
        return outcome;
      } catch (error) {
        const failed: StartOutcome = {
          kind: 'failed',
          error: error instanceof Error ? error.message : undefined,
        };
        settle(failed);
        return failed;
      } finally {
        setStarting(false);
      }
    },
    [agentStart, settle],
  );

  /**
   * 左栏组头「在此工作区新建会话」:回空态 + 空态输入器预选该组目录。
   * 种子是每次点击新建的对象——对象身份充当触发信号,重复点同一组也会重新套用。
   */
  const [workspaceSeed, setWorkspaceSeed] = useState<{ path?: string } | null>(null);
  const newSessionIn = useCallback(
    (path?: string) => {
      setWorkspaceSeed({ path });
      shell.newSession();
    },
    [shell],
  );

  // 顶栏徽标跳转：选中目标 agent 即 reveal（不再有"找不到画布节点"的空转）
  useHeaderAction({
    // 会话 + worker 一起定位（worker 级 reveal，见 useHeaderAction 文件头）
    onReveal: shell.reveal,
    // 顶栏的「新建会话」语义与左栏一致：回空态
    onNewChat: shell.newSession,
  });

  // Esc 的第三级由模式各自注册（`useGlobalBinding`），壳只挂监听与 ⌘\
  useConsoleKeyboard({
    toggleModeEnabled: hasActiveSession,
    onToggleMode: useCallback(
      () => shell.setMode(shell.mode === 'dock' ? 'thread' : 'dock'),
      [shell],
    ),
    onEscape: useCallback(() => false, []),
  });

  /**
   * 空态的快捷卡片 = **任务模板**（「最近任务模板」，`TaskDefinitionLauncher` 的第三个入口）。
   * 不是历史会话行：点下去是"启动新运行"，不是"恢复已有会话"——两个动作语义相反，必须区分。
   */
  const templates = useMemo(
    () =>
      taskDefinitions.slice(0, 6).map((definition) => ({
        id: definition.definitionId,
        title: definition.name,
        description: definition.description,
        // i18n-ignore -- legacy persisted task category value
        meta: !definition.category || definition.category === 'custom' || definition.category === '自定义'
          ? t('sessionWorkbenchUi.shell.customCategory')
          : definition.category,
      })),
    [t, taskDefinitions],
  );

  const pickTemplate = useCallback(
    (id: string) => {
      const definition = taskDefinitions.find((candidate) => candidate.definitionId === id);
      if (definition) void launch(definition);
    },
    [launch, taskDefinitions],
  );

  const emptyState = (
    <EmptyState
      logoSrc={logo128}
      tagline={t('console.entryPromise')}
      templates={templates}
      onPickTemplate={pickTemplate}
      composer={
        <WelcomeInput
          sending={starting}
          onStart={quickChat}
          onPreviewImage={shell.setPreviewImage}
          workspaceSeed={workspaceSeed}
        />
      }
    />
  );

  const topRailActions = useMemo(
    () => (
      <>
        <TaskDefinitionLauncher
          definitions={taskDefinitions}
          onStart={(definition) => void launch(definition)}
          onCreate={() => setTaskEditor({ kind: 'create' })}
          onEdit={(definition) => setTaskEditor({ kind: 'edit', definition })}
          onDelete={(definitionId) => void deleteTaskDefinition(definitionId)}
        />
        {hasActiveSession && <ModeSwitch mode={shell.mode} onChange={shell.setMode} />}
      </>
    ),
    [deleteTaskDefinition, hasActiveSession, launch, shell.mode, shell.setMode, taskDefinitions],
  );

  const shared = {
    sessions: shell.sessions,
    history: shell.history,
    selectedAgentId: shell.selectedAgentId,
    onSelectSession: shell.selectSession,
    onSelectHistory: shell.openHistory,
    menuSourceOf: shell.menuSourceOf,
    emptyState,
    onPreviewImage: shell.setPreviewImage,
    onStartTask: () => setTaskEditor({ kind: 'create' }),
    onNewSession: shell.newSession,
    onNewSessionIn: newSessionIn,
    devMode,
    // 收起态两模式共用同一份状态：展开 240 / 收起 52，切模式时左栏宽度不变
    sessionsCollapsed: shell.sessionsCollapsed,
    onToggleSessions: shell.toggleSessions,
    // 顶栏徽标的 worker 级定位请求；由各模式落到自己的选中态
    revealWorker: shell.revealWorker,
    topRailActions,
  };

  return (
    <div className={styles.shell}>
      {visibleError && (
        <div className={styles.startError}>
          <ErrorBar error={{ message: visibleError }} />
          <button
            type="button"
            className={styles.startErrorClose}
            onClick={() => {
              if (startError) setStartError(null);
              else void runtime.taskDefinitions.refresh();
            }}
            aria-label={t('sessionWorkbenchUi.shell.close')}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {renderedMode === 'dock' ? <DockMode {...shared} /> : <ThreadMode {...shared} />}

      <TaskDefinitionModal
        open={taskEditor !== null}
        editingDefinition={taskEditor?.kind === 'edit' ? taskEditor.definition : undefined}
        allowUpdateAndStart={taskEditor?.kind === 'edit'}
        onClose={() => setTaskEditor(null)}
        onCreated={(definition, shouldStart) => {
          setTaskEditor(null);
          // shouldStart 由弹层决定（"创建并启动" vs 仅创建），语义原样沿用
          if (shouldStart) void launch(definition);
        }}
        onUpdated={(definition, shouldStart) => {
          setTaskEditor(null);
          if (shouldStart) void launch(definition);
        }}
      />


      <ImageLightbox
        preview={shell.previewImage}
        onClose={() => shell.setPreviewImage(null)}
      />
    </div>
  );
};

const ConsolePage: React.FC = () => <ConsoleShellView />;

export default ConsolePage;
