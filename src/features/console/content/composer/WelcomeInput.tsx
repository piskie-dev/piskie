import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatModelReference, useInferenceStore } from '../../../../store/inferenceStore';
import { composeAttachmentText, useAttachmentDraft } from '../../attachments';
import { messageText, presentationFromError, type PresentationText } from '../../../../i18n/presentationText';
import {
  submitComposerDraft,
  useComposerDraft,
  useComposerDraftSettings,
  useComposerDraftStore,
  useComposerDraftVersion,
  useComposerSkills,
  WELCOME_DRAFT_KEY,
} from '../../data/composer-drafts';
import { useMcpPrewarm } from '../../data/useMcpPrewarm';
import type { QuickChatOptions, StartOutcome } from '../../shell/useAgentStart';
import { McpRuntimeCard } from '../McpRuntimeCard';
import { WelcomeComposer } from './WelcomeComposer';

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
  const [skills, setSkills] = useComposerSkills(WELCOME_DRAFT_KEY);
  const [settings, patchSettings] = useComposerDraftSettings(WELCOME_DRAFT_KEY);
  const { modeId, approvalMode, model, workspace, environmentIds } = settings;
  const version = useComposerDraftVersion(WELCOME_DRAFT_KEY);
  const selectApprovalMode = useComposerDraftStore((state) => state.selectApprovalMode);
  const attachments = useAttachmentDraft(WELCOME_DRAFT_KEY, setDraft);
  const [preparing, setPreparing] = useState(false);
  const [submitError, setSubmitError] = useState<PresentationText>();
  const submitting = useRef(false);

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
    if (paths[0]) patchSettings({ workspace: paths[0] });
  }, [patchSettings]);

  const submit = useCallback(async () => {
    if (sending || submitting.current || (!draft.trim() && !attachments.hasAttachments && skills.length === 0)) return;
    submitting.current = true;
    setPreparing(true);
    setSubmitError(undefined);
    try {
      const ok = await submitComposerDraft(WELCOME_DRAFT_KEY, async (snapshot, images, files) => {
        const text = composeAttachmentText(snapshot.text, files, Boolean(images?.length));
        const mcpPrewarmToken = prewarm.claim();
        let started = false;
        try {
          const outcome = await onStart(text, {
            ...settings, model: resolvedModel, images,
            skills: snapshot.skills.length > 0 ? [...snapshot.skills] : undefined,
            mcpPrewarmToken,
          });
          started = outcome.kind === 'started';
          return started;
        } finally { prewarm.settle(mcpPrewarmToken, started); }
      });
      if (!ok) setSubmitError(messageText('sessionWorkbenchUi.attachmentFailure.delivery'));
    } catch (error) {
      setSubmitError(presentationFromError(error, messageText('sessionWorkbenchUi.attachmentFailure.delivery')));
    } finally {
      submitting.current = false;
      setPreparing(false);
    }
  }, [attachments, draft, onStart, prewarm, resolvedModel, sending, settings, skills]);

  return (
    <WelcomeComposer
      value={draft}
      onChange={setDraft}
      skills={skills}
      onSkillsChange={setSkills}
      draftIdentity={`${WELCOME_DRAFT_KEY}:${version}`}
      onSubmit={submit}
      onPaste={attachments.handlePaste}
      placeholder={modeId === 'browser-skill'
        ? t('sessionWorkbenchUi.shell.describeWebsiteSkill')
        : t('sessionWorkbenchUi.shell.describeTask')}
      sending={sending || preparing}
      error={submitError}
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
  );
};
