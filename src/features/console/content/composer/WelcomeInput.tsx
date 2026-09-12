import React, { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatModelReference, useInferenceStore } from '../../../../store/inferenceStore';
import { composeAttachmentText, useAttachmentDraft } from '../../attachments';
import {
  getComposerDraftVersion,
  useComposerDraft,
  useComposerDraftSettings,
  useComposerDraftStore,
  useComposerDraftVersion,
  WELCOME_DRAFT_KEY,
} from '../../data/composer-drafts';
import { useMcpPrewarm } from '../../data/useMcpPrewarm';
import type { QuickChatOptions, StartOutcome } from '../../shell/useAgentStart';
import { McpRuntimeCard } from '../McpRuntimeCard';
import { WelcomeComposer } from './WelcomeComposer';
import { useAgentRunList } from '../../../../renderer-runtime/hooks';
import { WelcomeGuide } from '../../../guides/WelcomeGuide';

/**
 * 空态的输入器：还没有会话，投递即"新建并启动"。
 * 选项与文字、附件一起保留，成功启动后整份清空，失败时继续保留。
 */
export const WelcomeInput: React.FC<{
  readonly sending: boolean;
  readonly onStart: (text: string, options: QuickChatOptions) => Promise<StartOutcome>;
  readonly onPreviewImage?: (src: string) => void;
}> = ({ sending, onStart, onPreviewImage }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useComposerDraft(WELCOME_DRAFT_KEY);
  const [settings, patchSettings] = useComposerDraftSettings(WELCOME_DRAFT_KEY);
  const { modeId, approvalMode, model, workspace, environmentIds } = settings;
  const version = useComposerDraftVersion(WELCOME_DRAFT_KEY);
  const resetDraft = useComposerDraftStore((state) => state.resetDraft);
  const selectApprovalMode = useComposerDraftStore((state) => state.selectApprovalMode);
  const attachments = useAttachmentDraft(WELCOME_DRAFT_KEY);
  const submitting = useRef(false);

  const inferenceSelections = useInferenceStore((store) => store.selections);
  const historyReady = useAgentRunList((state) => state.phase === 'ready');
  const hasHistory = useAgentRunList((state) => state.runs.length > 0);
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
    if (paths[0]) patchSettings({ workspace: paths[0] });
  }, [patchSettings]);

  const submit = useCallback(async () => {
    if (submitting.current || (!draft.trim() && !attachments.hasAttachments)) return;
    submitting.current = true;
    try {
      const text = composeAttachmentText(draft, attachments.files, attachments.images.length > 0);
      const images = await attachments.imagePayloads();
      const mcpPrewarmToken = prewarm.claim();
      const outcome = await onStart(text, {
        ...settings,
        model: resolvedModel,
        images,
        mcpPrewarmToken,
      });
      prewarm.settle(mcpPrewarmToken, outcome.kind === 'started');
      if (outcome.kind === 'started' && getComposerDraftVersion(WELCOME_DRAFT_KEY) === version) {
        resetDraft(WELCOME_DRAFT_KEY);
      }
    } finally {
      submitting.current = false;
    }
  }, [attachments, draft, onStart, prewarm, resolvedModel, resetDraft, settings, version]);

  return (
    <>
    <WelcomeGuide
      historyReady={historyReady}
      hasHistory={hasHistory}
      blocked={sending || Boolean(draft.trim()) || attachments.hasAttachments || Boolean(workspace) || environmentIds.length > 0}
    />
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
      onModelChange={(next) => patchSettings({ model: next })}
      modeId={modeId}
      onModeChange={(nextMode) => {
        if (nextMode === 'normal' || nextMode === 'plan' || nextMode === 'browser-skill') {
          patchSettings({ modeId: nextMode });
        }
      }}
      approvalMode={approvalMode}
      onApprovalModeChange={(next) => {
        patchSettings({ approvalMode: next });
        selectApprovalMode(next);
      }}
      workspaceLabel={workspaceLabel}
      workspacePath={workspace}
      onSelectWorkspace={() => void selectWorkspace()}
      onUseDefaultWorkspace={() => patchSettings({ workspace: undefined })}
      environmentIds={environmentIds}
      onEnvironmentIdsChange={(next) => patchSettings({ environmentIds: next })}
      statusSlot={(
        <McpRuntimeCard
          view={prewarm.view}
          error={prewarm.error}
          workspace={workspace}
          variant="composer"
        />
      )}
    />
    </>
  );
};
