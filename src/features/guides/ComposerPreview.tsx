import { ChevronDown, Chrome, FileText, FolderOpen, Plus, SendHorizonal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import composer from '../console/content/composer/welcomeComposer.module.css';
import picker from '../../components/bindingPicker.module.css';
import inline from '../../components/agent-params/inlineSelect.module.css';
import s from './businessScenes.module.css';

/** WelcomeComposer's layout, with controlled display values and no live selectors. */
export function ComposerPreview({
  value,
  workspace = false,
  attachment = false,
  browser = false,
  pickingBrowser = false,
  selectedBrowser = false,
  plan = false,
  children,
}: {
  readonly value: string;
  readonly workspace?: boolean;
  readonly attachment?: boolean;
  readonly browser?: boolean;
  readonly pickingBrowser?: boolean;
  readonly selectedBrowser?: boolean;
  readonly plan?: boolean;
  readonly children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={`${composer.composerBlock} ${s.composer}`} data-guide-source="WelcomeComposer">
      <div className={composer.composerFrame}>
        <div className={composer.composerShell}>
          {attachment && (
            <div className={composer.attachments}>
              <div className={composer.fileChip}>
                <FileText size={13} />
                <span className={composer.fileName}>{t('guides.examples.attachment')}</span>
                <X size={9} />
              </div>
            </div>
          )}
          <div className={composer.textareaWrap}>
            <div className={`${composer.textarea} ${s.composerText}`} data-guide-target="task-input">
              {value || t('sessionWorkbenchUi.shell.describeTask')}
            </div>
          </div>
          <div className={composer.toolbar}>
            <div className={composer.toolbarGroup}>
              <div className={composer.primaryControls}>
                <span className={`${composer.modelReasoningSlot} ${s.composerModel}`}>
                  {t('guides.examples.modelName')}
                  <ChevronDown size={11} />
                </span>
                <span className={composer.controlPill} data-guide-target="mode">
                  <span className={inline.select}>
                    {t(plan ? 'sharedUi.agentParams.plan' : 'sharedUi.agentParams.normal')}
                    <ChevronDown size={11} />
                  </span>
                  {children}
                </span>
                <span className={composer.controlPill}>
                  {t('sharedUi.agentParams.confirm')}
                  <ChevronDown size={11} />
                </span>
              </div>
              <div className={composer.secondaryControls}>
                <span
                  className={`${composer.controlPill} ${composer.workspaceButton}`}
                  data-guide-target="workspace"
                >
                  <FolderOpen size={14} />
                  <span className={composer.workspaceButtonText}>
                    {workspace
                      ? t('guides.examples.workspace')
                      : t('sessionWorkbenchUi.shell.defaultWorkspace')}
                  </span>
                </span>
                <span
                  className={`${composer.controlPill} ${composer.resourceControl}`}
                  data-demo-target={browser || undefined}
                  data-guide-target="browser-trigger"
                >
                  <Chrome size={14} />
                  {selectedBrowser && <span className={picker.tag} data-tone="blue">
                    <span className="text-xs">{t('guides.workflows.browser.name')}</span>
                    <span className={picker.tagClose}><X size={10} /></span>
                  </span>}
                  <Plus size={11} />
                  {t(selectedBrowser ? 'sharedUi.browserBinding.add' : 'sharedUi.browserBinding.choose')}
                </span>
                {attachment && (
                  <span className={composer.attachmentPill} data-guide-target="attachment">
                    <FileText size={13} />1
                  </span>
                )}
              </div>
            </div>
            <span
              className={`${composer.sendButton} ${composer.sendEnabled}`}
              data-guide-target="send"
            >
              <SendHorizonal size={18} />
            </span>
          </div>
        </div>
      </div>
      {pickingBrowser && (
        <div className={`${picker.menu} ${s.browserPicker}`}>
          <div className={picker.menuItem} data-guide-target="browser-option">
            <Chrome size={14} />
            <span>{t('guides.workflows.browser.name')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
