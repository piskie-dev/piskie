/**
 * IM 渠道页「双玻璃名册档案」（路由 /messaging）。
 *
 * 舞台(壁纸直透,无页面底色)上两块玻璃纸:左名册 / 右档案。
 * 本组件只做装配:数据拉取(目录/连接/待授权/任务模板)、
 * 焦点状态(选中 Bot / 新建草稿)、全局错误条与瞬时提示。
 * store 不变式(状态事件只回写运行态、保留本地 config)在 messagingStore,页面只消费。
 */

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SetupGuide } from '../../../shared/types/setup-guide';
import {
  resolvePresentationText,
  type PresentationText,
} from '../../i18n/presentationText';
import { useRendererRuntime } from '../../renderer-runtime/hooks';
import { useMessagingStore } from '../../store/messagingStore';
import { DossierPane, type DossierFocus } from './DossierPane';
import { RosterPane } from './RosterPane';
import styles from './dossier.module.css';

export const ImDossierPage: React.FC = () => {
  const { t } = useTranslation();
  const runtime = useRendererRuntime();
  const error = useMessagingStore((s) => s.error);
  const clearError = useMessagingStore((s) => s.clearError);
  const fetchConnectorDescriptors = useMessagingStore((s) => s.fetchConnectorDescriptors);
  const fetchConnections = useMessagingStore((s) => s.fetchConnections);
  const fetchSenderAuthorizationRequests = useMessagingStore((s) => s.fetchSenderAuthorizationRequests);

  const [focus, setFocus] = useState<DossierFocus | null>(null);
  const [flash, setFlash] = useState<{
    text: PresentationText;
    tone: 'halt' | 'hold' | 'calm';
  } | null>(null);

  const pageGuide: SetupGuide = {
    consoleURL: '',
    steps: [
      {
        title: t('imPlugin.guide.pageStepAddTitle'),
        description: t('imPlugin.guide.pageStepAddDescription'),
      },
      {
        title: t('imPlugin.guide.pageStepBindTitle'),
        description: t('imPlugin.guide.pageStepBindDescription'),
      },
      {
        title: t('imPlugin.guide.pageStepLaunchTitle'),
        description: t('imPlugin.guide.pageStepLaunchDescription'),
      },
    ],
    notes: [
      t('imPlugin.guide.pageNoteTemplateOwnership'),
      t('imPlugin.guide.pageNoteLifecycle'),
    ],
  };

  useEffect(() => {
    void fetchConnectorDescriptors();
    void fetchConnections();
    void fetchSenderAuthorizationRequests();
    void runtime.taskDefinitions.refresh();
  }, [
    fetchConnectorDescriptors,
    fetchConnections,
    fetchSenderAuthorizationRequests,
    runtime,
  ]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(timer);
  }, [flash]);

  const onFlash = (text: PresentationText, tone: 'halt' | 'hold' | 'calm' = 'calm'): void => {
    setFlash({ text, tone });
  };

  const focusKey =
    focus === null ? 'blank' : focus.kind === 'bot' ? `bot:${focus.botId}` : `draft:${focus.channelId ?? ''}`;

  return (
    <div className={styles.stage}>
      {(error || flash) && (
        <div className={styles.stripDock}>
          {error && (
            <div className={styles.strip} role="alert">
              <span className={styles.stripText} title={error}>
                {error}
              </span>
              <button type="button" className={styles.stripClose} aria-label={t('common.close')} onClick={clearError}>
                <X size={12} />
              </button>
            </div>
          )}
          {flash && (
            <div className={styles.strip} data-tone={flash.tone}>
              <span className={styles.stripText}>
                {resolvePresentationText(flash.text, (key, values) => t(key, values ?? {}))}
              </span>
              <button
                type="button"
                className={styles.stripClose}
                aria-label={t('common.close')}
                onClick={() => setFlash(null)}
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>
      )}

      <RosterPane
        pickedBotId={focus?.kind === 'bot' ? focus.botId : null}
        onPick={(botId) => setFocus({ kind: 'bot', botId })}
        onDraft={(channelId) => setFocus({ kind: 'draft', channelId })}
        pageGuide={pageGuide}
      />

      <DossierPane
        key={focusKey}
        focus={focus}
        pageGuide={pageGuide}
        onFlash={onFlash}
        onDismiss={() => setFocus(null)}
        onSaved={(botId) => setFocus({ kind: 'bot', botId })}
        onDraft={(channelId) => setFocus({ kind: 'draft', channelId })}
      />
    </div>
  );
};
