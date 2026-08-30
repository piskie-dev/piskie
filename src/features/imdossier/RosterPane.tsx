/**
 * 名册（双玻璃名册档案 · 左玻璃）。
 *
 * 页首(标题/待授权铃/使用指引/刷新)+ 添加 Bot + 渠道分组清单。
 * 渠道分组常驻(目录来自 listConnectors,不硬编码);空渠道给幽灵行;
 * 目录加载给骨架、空目录给重启提示;孤儿 Bot(渠道目录缺失其 channelType)
 * 归入「未知渠道」组不丢行。行 = 头像状态环 + 名称 + 模板/告警副行 +
 * 单 Bot 待授权计数 + 状态词;点行选中(档案在右玻璃展开)。
 */

import React from 'react';
import { Plus, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MessagingConnectionState } from '../../../shared/electron-contracts/messaging';
import { useTaskDefinitionRepository } from '../../renderer-runtime/hooks';
import { useMessagingStore } from '../../store/messagingStore';
import type { SetupGuide } from '../../../shared/types/setup-guide';
import { resolvePresentationText } from '../../i18n/presentationText';
import {
  CHANNEL_TITLE_KEYS,
  SCAN_LOGIN_CHANNELS,
  SOLO_BOT_CHANNELS,
  channelMark,
  statusText,
} from './data/channel-facts';
import { HandbookPopover } from './HandbookPopover';
import { PendingPopover } from './PendingPopover';
import styles from './dossier.module.css';

export interface RosterPaneProps {
  readonly pickedBotId: string | null;
  readonly onPick: (botId: string) => void;
  /** 进入新建态;channelId 缺省 = 未预选渠道 */
  readonly onDraft: (channelId?: string) => void;
  readonly pageGuide: SetupGuide;
}

export const RosterPane: React.FC<RosterPaneProps> = ({ pickedBotId, onPick, onDraft, pageGuide }) => {
  const { t } = useTranslation();
  const present = (value: ReturnType<typeof statusText>): string => (
    resolvePresentationText(value, (key, values) => t(key, values ?? {}))
  );
  const descriptors = useMessagingStore((s) => s.connectorDescriptors);
  const connections = useMessagingStore((s) => s.connections);
  const requests = useMessagingStore((s) => s.senderAuthorizationRequests);
  const isLoadingConnectors = useMessagingStore((s) => s.isLoadingConnectors);
  const isLoadingConnections = useMessagingStore((s) => s.isLoadingConnections);
  const fetchConnectorDescriptors = useMessagingStore((s) => s.fetchConnectorDescriptors);
  const fetchConnections = useMessagingStore((s) => s.fetchConnections);
  const taskDefinitions = useTaskDefinitionRepository((state) => state.definitions);

  const refreshAll = (): void => {
    void fetchConnectorDescriptors();
    void fetchConnections();
  };

  const renderEntry = (connection: MessagingConnectionState): React.ReactNode => {
    const { config, status } = connection;
    const template = config.definitionId
      ? taskDefinitions.find((definition) => definition.definitionId === config.definitionId)
      : undefined;
    const pendingCount = requests.filter((request) => request.botId === config.id).length;

    return (
      <div
        key={config.id}
        className={styles.entry}
        data-picked={config.id === pickedBotId}
        role="button"
        tabIndex={0}
        onClick={() => onPick(config.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onPick(config.id);
          }
        }}
      >
        <span className={styles.mark}>
          {channelMark(config.channelType)}
          <span className={styles.markDot} data-s={status} />
        </span>
        <span className={styles.entryBody}>
          <span className={styles.entryName} title={config.name}>
            {config.name}
          </span>
          {config.definitionId ? (
            <span className={styles.entryNote} title={template?.name}>
              {template?.name ?? t('imPlugin.roster.templateUnavailable')}
              {pendingCount > 0 && ` · ${t('imPlugin.roster.pendingReviewCount', { count: pendingCount })}`}
            </span>
          ) : (
            <span className={styles.entryNote} data-warn="true">
              {t('imPlugin.roster.bindingNeededToStart')}
            </span>
          )}
        </span>
        <span className={styles.entryState} data-s={status}>
          {present(statusText(status))}
        </span>
      </div>
    );
  };

  const renderGroup = (
    key: string,
    title: string,
    tag: string,
    bots: readonly MessagingConnectionState[],
    channelId?: string,
  ): React.ReactNode => {
    const soloTaken = channelId !== undefined && SOLO_BOT_CHANNELS.has(channelId) && bots.length >= 1;
    return (
      <section key={key}>
        <div className={styles.chanCap}>
          <b>{title}</b>
          <span className={styles.capTag}>{tag}</span>
          <span className={styles.capSpring} />
          {channelId && !soloTaken && (
            <button
              type="button"
              className={styles.capAdd}
              aria-label={t('imPlugin.roster.addToChannel', { channel: title })}
              onClick={() => onDraft(channelId)}
            >
              <Plus size={12} />
            </button>
          )}
        </div>
        {bots.length > 0
          ? bots.map(renderEntry)
          : channelId && (
              <div
                className={styles.ghostEntry}
                role="button"
                tabIndex={0}
                onClick={() => onDraft(channelId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onDraft(channelId);
                  }
                }}
              >
                <Plus size={12} />
                {t('imPlugin.roster.emptyChannel')}
              </div>
            )}
      </section>
    );
  };

  const knownChannels = new Set(descriptors.map((descriptor) => descriptor.channelId));
  const orphans = connections.filter((connection) => !knownChannels.has(connection.config.channelType));

  return (
    <aside className={`${styles.pane} ${styles.roster}`} aria-label={t('imPlugin.roster.ariaLabel')}>
      <div className={styles.crown}>
        <span className={styles.crownTitle}>{t('nav.messagingDock')}</span>
        <PendingPopover />
        <HandbookPopover guide={pageGuide} />
        <button
          type="button"
          className={styles.orb}
          aria-label={t('common.refresh')}
          title={t('common.refresh')}
          disabled={isLoadingConnectors || isLoadingConnections}
          onClick={refreshAll}
        >
          <RotateCw size={13} />
        </button>
      </div>

      <button
        type="button"
        className={styles.recruit}
        disabled={descriptors.length === 0}
        onClick={() => onDraft()}
      >
        ＋ {t('imPlugin.newBot')}
      </button>

      <div className={styles.census}>
        {isLoadingConnectors && descriptors.length === 0 ? (
          <>
            <div className={styles.skeletonEntry} />
            <div className={styles.skeletonEntry} />
            <div className={styles.skeletonEntry} />
          </>
        ) : descriptors.length === 0 ? (
          <div className={styles.voidBox}>
            {t('imPlugin.channelCatalogUnavailable')}
            <button type="button" className={styles.btn} onClick={refreshAll}>
              {t('common.refresh')}
            </button>
          </div>
        ) : (
          <>
            {descriptors.map((descriptor) => {
              const titleKey = CHANNEL_TITLE_KEYS[descriptor.channelId];
              const tagBits = [descriptor.channelId.toUpperCase()];
              if (SOLO_BOT_CHANNELS.has(descriptor.channelId)) {
                tagBits.push(t('imPlugin.roster.singleBotTag'));
              }
              if (SCAN_LOGIN_CHANNELS.has(descriptor.channelId)) {
                tagBits.push(t('imPlugin.roster.scanSignInTag'));
              }
              return renderGroup(
                descriptor.channelId,
                titleKey ? t(titleKey) : descriptor.displayName,
                tagBits.join(' · '),
                connections.filter((connection) => connection.config.channelType === descriptor.channelId),
                descriptor.channelId,
              );
            })}
            {orphans.length > 0 && renderGroup(
              '__orphans__',
              t('imPlugin.roster.unknownChannel'),
              'UNKNOWN',
              orphans,
            )}
          </>
        )}
      </div>
    </aside>
  );
};
