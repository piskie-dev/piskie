/**
 * 档案（双玻璃名册档案 · 右玻璃）。
 *
 * 常驻详情面板,配置即阅读(取代一切弹窗/浮层检查器)。三种形态:
 * - 空态:页级使用指引 + 添加引导
 * - 新建态:渠道选择(wecom 已占禁选)→ 表单
 * - 编辑态:页首(头像状态环/名称/状态/生命周期操作)+ 七区正文
 *   (基本/凭证/绑定任务模板/准入/回复转发/已授权用户/待授权请求)
 *
 * 关键约束：启动必绑、未绑告警态、模板排他、非静止锁改绑、
 * Secret 留空保旧、weixin 扫码全链路(重登先停/成功自动启动/退出登录)、
 * stop_failed 复用停止重试、删除仅限静止(两段确认)、保存提示双语义。
 * 宿主经 key 重挂载本组件(切换焦点即重置表单),表单种子只在挂载时取一次。
 */

import React, { useEffect, useRef, useState } from 'react';
import { MessagesSquare, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { createUuid } from '@shared/utils/identifiers.js';
import type { SetupGuide } from '../../../shared/types/setup-guide';
import type { MessagingConnectionConfig } from '../../../shared/electron-contracts/messaging';
import { CHANNEL_SETUP_GUIDES } from '../../../shared/constants/channel-setup-guides';
import { TaskDefinitionModal } from '../../components/task-definition/TaskDefinitionModal';
import {
  messageText,
  resolvePresentationText,
  type PresentationText,
} from '../../i18n/presentationText';
import { useTaskDefinitionRepository } from '../../renderer-runtime/hooks';
import { useMessagingStore } from '../../store/messagingStore';
import {
  CHANNEL_TITLE_KEYS,
  DM_POLICY_KEYS,
  GROUP_POLICY_KEYS,
  SCAN_LOGIN_CHANNELS,
  SOLO_BOT_CHANNELS,
  atRest,
  channelMark,
  sinceText,
  statusText,
} from './data/channel-facts';
import { faultOfForm, fuseBotRecord, type DossierFormValues, type FormFault } from './data/record-fuse';
import { claimTemplateOptions } from './data/template-claims';
import { ChannelGuideFold, GuideSteps } from './HandbookPopover';
import { TemplateDropdown } from './TemplateDropdown';
import { WeixinQrFlow } from './WeixinQrFlow';
import styles from './dossier.module.css';

export type DossierFocus = { kind: 'bot'; botId: string } | { kind: 'draft'; channelId?: string };

export interface DossierPaneProps {
  readonly focus: DossierFocus | null;
  readonly pageGuide: SetupGuide;
  readonly onFlash: (text: PresentationText, tone?: 'halt' | 'hold' | 'calm') => void;
  /** 取消/焦点对象消失 → 回空态 */
  readonly onDismiss: () => void;
  /** 新建保存成功 → 焦点切到新 Bot */
  readonly onSaved: (botId: string) => void;
  readonly onDraft: (channelId?: string) => void;
}

/** 凭证字段标签(渠道分化;weixin 无凭证不在此表) */
const CREDENTIAL_LABELS: Record<string, [string, string]> = {
  wecom: ['Bot ID', 'Bot Secret'],
  qqbot: ['App ID', 'App Secret'],
  feishu: ['App ID', 'App Secret'],
};

function seedForm(persisted: MessagingConnectionConfig | undefined): Omit<DossierFormValues, 'channelType'> {
  return {
    name: persisted?.name ?? '',
    appId: persisted?.appId ?? '',
    appSecret: '',
    definitionId: persisted?.definitionId,
    dmPolicy: persisted?.dmPolicy ?? 'pairing',
    groupPolicy: persisted?.groupPolicy ?? 'disabled',
    groupAllowText: (persisted?.groupAllowFrom ?? []).join('\n'),
    requireMention: persisted?.requireMention ?? true,
    forwardAssistantText: persisted?.replyForward?.forwardAssistantText ?? true,
    forwardToolCalls: persisted?.replyForward?.forwardToolCalls ?? false,
    forwardToolResults: persisted?.replyForward?.forwardToolResults ?? false,
  };
}

export const DossierPane: React.FC<DossierPaneProps> = ({
  focus,
  pageGuide,
  onFlash,
  onDismiss,
  onSaved,
  onDraft,
}) => {
  const { t } = useTranslation();
  const present = (value: PresentationText): string => (
    resolvePresentationText(value, (key, values) => t(key, values ?? {}))
  );
  const descriptors = useMessagingStore((s) => s.connectorDescriptors);
  const connections = useMessagingStore((s) => s.connections);
  const requests = useMessagingStore((s) => s.senderAuthorizationRequests);
  const authorizedUsers = useMessagingStore((s) => s.authorizedUsers);
  const saveConnection = useMessagingStore((s) => s.saveConnection);
  const deleteConnection = useMessagingStore((s) => s.deleteConnection);
  const startConnection = useMessagingStore((s) => s.startConnection);
  const stopConnection = useMessagingStore((s) => s.stopConnection);
  const fetchConnections = useMessagingStore((s) => s.fetchConnections);
  const fetchAuthorizedUsers = useMessagingStore((s) => s.fetchAuthorizedUsers);
  const addAuthorizedUser = useMessagingStore((s) => s.addAuthorizedUser);
  const removeAuthorizedUser = useMessagingStore((s) => s.removeAuthorizedUser);
  const approveRequest = useMessagingStore((s) => s.approveSenderAuthorization);
  const rejectRequest = useMessagingStore((s) => s.rejectSenderAuthorization);
  const logoutAccount = useMessagingStore((s) => s.logoutAccount);
  const taskDefinitions = useTaskDefinitionRepository((state) => state.definitions);

  const isBot = focus?.kind === 'bot';
  const bot = isBot ? connections.find((c) => c.config.id === focus.botId) : undefined;
  const persisted = bot?.config;

  const [draftChannel, setDraftChannel] = useState<string | undefined>(
    focus?.kind === 'draft' ? focus.channelId : undefined,
  );
  const channelType = isBot ? (persisted?.channelType ?? '') : (draftChannel ?? '');
  const scanLogin = SCAN_LOGIN_CHANNELS.has(channelType);
  const status = bot?.status ?? 'stopped';
  const rest = isBot ? atRest(status) : true;
  const loggedIn = !!persisted?.pluginAccountId;

  const [form, setForm] = useState(() => seedForm(persisted));
  const [formFault, setFormFault] = useState<FormFault | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  const [qrSession, setQrSession] = useState<{ force: boolean } | null>(null);
  const [defModalOpen, setDefModalOpen] = useState(false);
  const [userDraft, setUserDraft] = useState('');

  const patch = (next: Partial<typeof form>): void => {
    setFormFault(null);
    setForm((current) => ({ ...current, ...next }));
  };

  // 焦点 Bot 被删(本页或事件流)→ 回空态
  useEffect(() => {
    if (isBot && !bot) onDismiss();
  }, [isBot, bot, onDismiss]);

  // 校验失败:滚动定位到问题控件(红光 + 轻晃在皮肤层)
  useEffect(() => {
    if (!formFault) return;
    bodyRef.current
      ?.querySelector('[data-fault="true"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [formFault]);

  // 删除武装态 3s 回落
  useEffect(() => {
    if (!armedDelete) return;
    const timer = setTimeout(() => setArmedDelete(false), 3000);
    return () => clearTimeout(timer);
  }, [armedDelete]);

  // 已授权用户(编辑态)
  const botId = isBot ? focus.botId : null;
  const users = botId
    ? authorizedUsers.filter((user) => user.botId === botId)
    : [];
  useEffect(() => {
    if (!botId) return;
    void fetchAuthorizedUsers();
  }, [botId, fetchAuthorizedUsers]);

  /* ── 空态 ── */
  if (!focus) {
    return (
      <main className={`${styles.pane} ${styles.dossier}`} aria-label={t('imPlugin.dossier.ariaLabel')}>
        <div className={styles.blankDoss}>
          <span className={styles.blankGlyph}>
            <MessagesSquare size={22} />
          </span>
          <span className={styles.blankTitle}>{t('imPlugin.dossier.emptyPrompt')}</span>
          <div className={styles.blankSteps}>
            <GuideSteps guide={pageGuide} />
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrime}`}
            disabled={descriptors.length === 0}
            onClick={() => onDraft()}
          >
            ＋ {t('imPlugin.newBot')}
          </button>
        </div>
      </main>
    );
  }

  const channelTitleOf = (id: string): string => {
    const key = CHANNEL_TITLE_KEYS[id];
    if (key) return t(key);
    return descriptors.find((descriptor) => descriptor.channelId === id)?.displayName ?? id;
  };

  const claims = claimTemplateOptions(taskDefinitions, connections, botId);
  const guide = CHANNEL_SETUP_GUIDES[channelType];
  const credentialLabels = CREDENTIAL_LABELS[channelType] ?? ['App ID', 'App Secret'];
  const botRequests = botId ? requests.filter((request) => request.botId === botId) : [];

  const doSave = async (): Promise<void> => {
    if (saving) return;
    if (!channelType) {
      setFormFault({ field: 'channel', messageKey: 'imPlugin.validation.chooseChannel' });
      return;
    }
    const values: DossierFormValues = { ...form, channelType };
    const fault = faultOfForm(values, { scanLogin, hasStoredSecret: !!persisted?.appSecret });
    if (fault) {
      setFormFault(fault);
      return;
    }
    setSaving(true);
    const targetId = botId ?? `bot-${createUuid()}`;
    const record = fuseBotRecord(persisted, values, { botId: targetId, atRest: rest, scanLogin });
    const ok = await saveConnection(record);
    setSaving(false);
    if (!ok) return;
    if (rest) onFlash(messageText('imPlugin.settingsSaved'), 'calm');
    else onFlash(messageText('imPlugin.dossier.savedRestartNotice'), 'hold');
    if (!isBot) onSaved(targetId);
  };

  const doToggleRun = async (): Promise<void> => {
    if (!bot || !botId) return;
    if (!rest) {
      await stopConnection(botId);
      return;
    }
    if (scanLogin && !loggedIn) {
      onFlash(messageText('imPlugin.scanBeforeStart'), 'hold');
      return;
    }
    await startConnection(botId);
  };

  const doDelete = async (): Promise<void> => {
    if (!botId) return;
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }
    setArmedDelete(false);
    const ok = await deleteConnection(botId);
    if (ok) onFlash(messageText('imPlugin.dossier.botRemoved'), 'calm');
  };

  const openQr = async (): Promise<void> => {
    if (!botId) return;
    // 运行中的已登录 Bot 必须先停止，才能重新登录。
    if (loggedIn && !rest) await stopConnection(botId);
    setQrSession({ force: loggedIn });
  };

  const onQrConnected = (alreadyConnected: boolean): void => {
    setQrSession(null);
    onFlash(messageText(
      alreadyConnected
        ? 'imPlugin.dossier.accountAlreadyOnline'
        : 'imPlugin.dossier.scanSignInSucceeded',
    ), 'calm');
    void fetchConnections().then(() => {
      // 成功自动启动(需已绑模板;未绑由启动断言给出 error,不在这里启动)
      if (botId && persisted?.definitionId) void startConnection(botId);
    });
  };

  const doLogout = async (): Promise<void> => {
    if (!botId) return;
    if (!rest) await stopConnection(botId);
    const ok = await logoutAccount(botId);
    if (ok) onFlash(messageText('imPlugin.dossier.accountSignedOut'), 'calm');
  };

  const doAddUser = async (): Promise<void> => {
    const senderId = userDraft.trim();
    if (!botId || senderId.length === 0) return;
    setUserDraft('');
    const ok = await addAuthorizedUser(botId, senderId);
    if (!ok) setUserDraft(senderId);
  };

  const doRemoveUser = async (senderId: string): Promise<void> => {
    if (!botId) return;
    await removeAuthorizedUser(botId, senderId);
  };

  return (
    <main className={`${styles.pane} ${styles.dossier}`} aria-label={t('imPlugin.dossier.ariaLabel')}>
      {/* ── 页首 ── */}
      <div className={styles.dossHead}>
        <span className={`${styles.seal} ${styles.sealLg}`}>
          {channelType ? channelMark(channelType) : '＋'}
        </span>
        <span className={styles.dossIdent}>
          <div className={styles.dossTitle}>
            {isBot ? (persisted?.name ?? '') : t('imPlugin.newBot')}
          </div>
          <div className={styles.dossMeta}>
            {isBot && (
              <span className={styles.entryState} data-s={status}>
                {present(statusText(status))}
              </span>
            )}
            {channelType && <span>{channelTitleOf(channelType)}</span>}
            {isBot && scanLogin && (
              <span>
                {loggedIn
                  ? t('imPlugin.dossier.signedInAs', { account: persisted?.pluginAccountId ?? '' })
                  : t('imPlugin.dossier.signedOut')}
              </span>
            )}
            {isBot && persisted?.definitionId && <span>{t('imPlugin.dossier.isolatedSessions')}</span>}
          </div>
          {isBot && bot?.error && persisted?.definitionId && (
            <div className={styles.faultNote} title={bot.error}>
              {bot.error}
            </div>
          )}
        </span>
        <span className={styles.headSpring} />
        <span className={styles.headActs}>
          {isBot && scanLogin && (
            <button type="button" className={styles.btn} onClick={() => void openQr()}>
              {loggedIn ? t('imPlugin.dossier.signInAgain') : t('imPlugin.dossier.scanToSignIn')}
            </button>
          )}
          {isBot && (
            <button
              type="button"
              className={styles.btn}
              disabled={status === 'stopping' || (rest && !persisted?.definitionId && !scanLogin)}
              title={
                rest && !persisted?.definitionId
                  ? t('imPlugin.roster.bindingNeededToStart')
                  : undefined
              }
              onClick={() => void doToggleRun()}
            >
              {!rest
                ? status === 'stopping'
                  ? t('imPlugin.dossier.disconnecting')
                  : status === 'stop_failed'
                    ? t('imPlugin.dossier.retryDisconnect')
                    : t('imPlugin.stop')
                : t('imPlugin.start')}
            </button>
          )}
          {isBot && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnRisk} ${armedDelete ? styles.btnArmed : ''}`}
              disabled={!rest}
              title={!rest ? t('imPlugin.stopBeforeRemoval') : undefined}
              onClick={() => void doDelete()}
            >
              {armedDelete ? t('imPlugin.dossier.confirmRemoval') : t('common.delete')}
            </button>
          )}
          <button
            type="button"
            className={styles.orb}
            aria-label={t('common.close')}
            onClick={onDismiss}
          >
            <X size={14} />
          </button>
        </span>
      </div>

      {/* ── 正文 ── */}
      <div ref={bodyRef} className={styles.dossBody}>
        {/* 新建态:渠道选择 */}
        {!isBot && (
          <div className={styles.slab} data-wide="true">
            <div className={styles.slabCap}>{t('imPlugin.dossier.chooseChannel')}</div>
            <div className={styles.chanPickRack} data-fault={formFault?.field === 'channel' ? 'true' : undefined}>
              {descriptors.map((descriptor) => {
                const soloTaken =
                  SOLO_BOT_CHANNELS.has(descriptor.channelId) &&
                  connections.some((c) => c.config.channelType === descriptor.channelId);
                return (
                  <button
                    key={descriptor.channelId}
                    type="button"
                    className={styles.chanPick}
                    data-on={draftChannel === descriptor.channelId}
                    disabled={soloTaken}
                    onClick={() => {
                      setFormFault(null);
                      setDraftChannel(descriptor.channelId);
                    }}
                  >
                    <span className={styles.mark}>{channelMark(descriptor.channelId)}</span>
                    <span>
                      {channelTitleOf(descriptor.channelId)}
                      <span className={styles.chanPickNote}>
                        {soloTaken
                          ? t('imPlugin.dossier.channelAlreadyUsed')
                          : SCAN_LOGIN_CHANNELS.has(descriptor.channelId)
                            ? t('imPlugin.dossier.scanNeedsNoCredentials')
                            : descriptor.channelId.toUpperCase()}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Bot 名称(眉标即字段名,与右侧「绑定任务模板」同构对齐) */}
        <div className={styles.slab}>
          <label className={styles.slabCap} htmlFor="imd-name">
            {t('imPlugin.botName')}
          </label>
          <input
            id="imd-name"
            className={styles.textIn}
            value={form.name}
            data-fault={formFault?.field === 'name' ? 'true' : undefined}
            placeholder={t('imPlugin.botNameExample')}
            onChange={(event) => patch({ name: event.target.value })}
          />
          {formFault?.field === 'name' && (
            <div className={styles.fieldNote}>
              <span className={styles.faultNote}>{t(formFault.messageKey)}</span>
            </div>
          )}
        </div>

        {/* 绑定任务模板 */}
        <div className={styles.slab}>
          <div className={styles.slabCap}>
            {t('imPlugin.bindTaskDefinition')}
            <span className={styles.capSpring} />
            <button
              type="button"
              className={`${styles.btn} ${styles.btnQuiet}`}
              onClick={() => setDefModalOpen(true)}
            >
              {t('imPlugin.newTaskTemplate')}
            </button>
          </div>
          <TemplateDropdown
            claims={claims}
            value={form.definitionId}
            placeholder={t('imPlugin.bindTaskDefinitionPlaceholder')}
            disabled={isBot && !rest}
            disabledHint={t('imPlugin.dossier.bindingLocked')}
            fault={formFault?.field === 'definition'}
            onPick={(definitionId) => patch({ definitionId })}
          />
          {formFault?.field === 'definition' && (
            <div className={styles.fieldNote}>
              <span className={styles.faultNote}>{t(formFault.messageKey)}</span>
            </div>
          )}
        </div>

        {/* 凭证 */}
        <div className={styles.slab} data-wide="true">
          <div className={styles.slabCap}>
            {scanLogin
              ? t('imPlugin.dossier.signInSection')
              : t('imPlugin.dossier.credentialsSection')}
          </div>
          {!channelType ? (
            <div className={styles.fieldNote}>{t('imPlugin.dossier.chooseChannelFirst')}</div>
          ) : scanLogin ? (
            <div className={styles.fieldStack}>
              {isBot ? (
                <div className={styles.loginRow}>
                  <span className={styles.loginDot} data-on={loggedIn} />
                  {loggedIn
                    ? t('imPlugin.dossier.signedInAs', { account: persisted?.pluginAccountId ?? '' })
                    : t('imPlugin.dossier.signedOutScanReady')}
                  <span className={styles.capSpring} />
                  {loggedIn && (
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnQuiet} ${styles.btnRisk}`}
                      onClick={() => void doLogout()}
                    >
                      {t('imPlugin.dossier.signOutAction')}
                    </button>
                  )}
                  {!qrSession && (
                    <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={() => void openQr()}>
                      {loggedIn
                        ? t('imPlugin.dossier.signInAgain')
                        : t('imPlugin.dossier.scanToSignIn')}
                    </button>
                  )}
                </div>
              ) : (
                <div className={styles.fieldNote}>{t('imPlugin.dossier.saveThenScan')}</div>
              )}
              {qrSession && botId && (
                <WeixinQrFlow
                  botId={botId}
                  channelType={channelType}
                  force={qrSession.force}
                  onConnected={onQrConnected}
                  onDismiss={() => setQrSession(null)}
                />
              )}
            </div>
          ) : (
            <div className={styles.fieldStack}>
              <div>
                <label className={styles.fieldTag} htmlFor="imd-appid">
                  {credentialLabels[0]}
                </label>
                <input
                  id="imd-appid"
                  className={styles.textIn}
                  value={form.appId}
                  data-fault={formFault?.field === 'appId' ? 'true' : undefined}
                  placeholder={t('imPlugin.channelAppIdHint')}
                  onChange={(event) => patch({ appId: event.target.value })}
                />
                {formFault?.field === 'appId' && (
                  <div className={styles.fieldNote}>
                    <span className={styles.faultNote}>{t(formFault.messageKey)}</span>
                  </div>
                )}
              </div>
              <div>
                <label className={styles.fieldTag} htmlFor="imd-secret">
                  {credentialLabels[1]}
                </label>
                <input
                  id="imd-secret"
                  className={styles.textIn}
                  type="password"
                  value={form.appSecret}
                  data-fault={formFault?.field === 'appSecret' ? 'true' : undefined}
                  placeholder={
                    persisted?.appSecret
                      ? t('imPlugin.dossier.storedSecretHint')
                      : t('imPlugin.channelAppSecretHint')
                  }
                  onChange={(event) => patch({ appSecret: event.target.value })}
                />
                {formFault?.field === 'appSecret' && (
                  <div className={styles.fieldNote}>
                    <span className={styles.faultNote}>{t(formFault.messageKey)}</span>
                  </div>
                )}
              </div>
            </div>
          )}
          {guide && <ChannelGuideFold guide={guide} />}
        </div>

        {/* 准入:私聊 */}
        <div className={styles.slab}>
          <div className={styles.slabCap}>{t('imPlugin.directMessageAccess')}</div>
          <div className={styles.lever}>
            {DM_POLICY_KEYS.map(([value, key]) => (
              <button
                key={value}
                type="button"
                data-on={form.dmPolicy === value}
                onClick={() => patch({ dmPolicy: value })}
              >
                {t(key)}
              </button>
            ))}
          </div>
          {form.dmPolicy === 'pairing' && (
            <div className={styles.fieldNote}>{t('imPlugin.dossier.pairingExplanation')}</div>
          )}
        </div>

        {/* 准入:群聊 */}
        <div className={styles.slab}>
          <div className={styles.slabCap}>{t('imPlugin.groupAccess')}</div>
          <div className={styles.fieldStack}>
            <div className={styles.lever}>
              {GROUP_POLICY_KEYS.map(([value, key]) => (
                <button
                  key={value}
                  type="button"
                  data-on={form.groupPolicy === value}
                  onClick={() => patch({ groupPolicy: value })}
                >
                  {t(key)}
                </button>
              ))}
            </div>
            {form.groupPolicy === 'allowlist' && (
              <textarea
                className={styles.textIn}
                value={form.groupAllowText}
                placeholder={t('imPlugin.groupIdListHint')}
                onChange={(event) => patch({ groupAllowText: event.target.value })}
              />
            )}
            <button
              type="button"
              className={styles.flagRow}
              data-on={form.requireMention}
              onClick={() => patch({ requireMention: !form.requireMention })}
            >
              <span className={styles.flagText}>{t('imPlugin.respondOnMention')}</span>
              <span className={styles.flagPill} />
            </button>
          </div>
        </div>

        {/* 回复转发 */}
        <div className={styles.slab} data-wide="true">
          <div className={styles.slabCap}>{t('imPlugin.replyContent')}</div>
          <button
            type="button"
            className={styles.flagRow}
            data-on={form.forwardAssistantText}
            onClick={() => patch({ forwardAssistantText: !form.forwardAssistantText })}
          >
            <span className={styles.flagText}>{t('imPlugin.forwardAssistantText')}</span>
            <span className={styles.flagPill} />
          </button>
          <button
            type="button"
            className={styles.flagRow}
            data-on={form.forwardToolCalls}
            onClick={() => patch({ forwardToolCalls: !form.forwardToolCalls })}
          >
            <span className={styles.flagText}>
              {t('imPlugin.includeToolActivity')}
              <span className={styles.flagHint}>{t('imPlugin.forwardToolCallsHelp')}</span>
            </span>
            <span className={styles.flagPill} />
          </button>
          <button
            type="button"
            className={styles.flagRow}
            data-on={form.forwardToolResults}
            onClick={() => patch({ forwardToolResults: !form.forwardToolResults })}
          >
            <span className={styles.flagText}>
              {t('imPlugin.includeToolResults')}
              <span className={styles.flagHint}>{t('imPlugin.forwardToolResultsHelp')}</span>
            </span>
            <span className={styles.flagPill} />
          </button>
        </div>

        {/* 已授权用户(编辑态) */}
        {isBot && (
          <div className={styles.slab} data-wide="true">
            <div className={styles.slabCap}>
              {t('imPlugin.approvedSenders')} · {users.length}
            </div>
            {users.length === 0 ? (
              <div className={styles.fieldNote}>{t('imPlugin.noApprovedSenders')}</div>
            ) : (
              users.map((user) => (
                <span key={user.senderId} className={styles.userTag} title={user.senderId}>
                  {user.senderName ?? user.senderId}
                  <button
                    type="button"
                    aria-label={t('imPlugin.dossier.removeSender', {
                      name: user.senderName ?? user.senderId,
                    })}
                    onClick={() => void doRemoveUser(user.senderId)}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))
            )}
            <div className={styles.userAddRow}>
              <input
                className={styles.textIn}
                value={userDraft}
                placeholder={t('imPlugin.senderIdHint')}
                onChange={(event) => setUserDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void doAddUser();
                }}
              />
              <button type="button" className={styles.btn} onClick={() => void doAddUser()}>
                {t('imPlugin.approveSender')}
              </button>
            </div>
          </div>
        )}

        {/* 待授权请求(编辑态) */}
        {isBot && botRequests.length > 0 && (
          <div className={styles.slab} data-wide="true">
            <div className={styles.slabCap}>
              {t('imPlugin.senderAuthorization')} · {botRequests.length}
            </div>
            {botRequests.map((request) => (
              <div key={request.id} className={styles.askRow}>
                <span className={styles.askWho} title={request.senderId}>
                  <b>{request.senderName ?? request.senderId}</b>
                  {' · '}
                  {request.peerType === 'group' ? t('imPlugin.groupChat') : t('imPlugin.dmChat')}
                </span>
                <span className={styles.askCode} title={t('imPlugin.pairingCode')}>
                  {request.pairingCode}
                </span>
                <span className={styles.askMeta}>{present(sinceText(request.createdAt))}</span>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnQuiet} ${styles.btnLive}`}
                  onClick={() => void approveRequest(request.id)}
                >
                  {t('imPlugin.approve')}
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnQuiet}`}
                  onClick={() => void rejectRequest(request.id)}
                >
                  {t('imPlugin.reject')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 底栏:保存 ── */}
      <div className={styles.saveBar}>
        <span className={styles.saveHint} data-warn={isBot && !rest ? 'true' : undefined}>
          {formFault ? (
            <span className={styles.faultNote}>{t(formFault.messageKey)}</span>
          ) : isBot && !rest ? (
            t('imPlugin.dossier.runningSaveHint')
          ) : (
            t('imPlugin.dossier.immediateSaveHint')
          )}
        </span>
        <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} disabled={saving} onClick={onDismiss}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrime}`}
          disabled={saving}
          onClick={() => void doSave()}
        >
          {saving ? t('imPlugin.dossier.savingSettings') : t('common.save')}
        </button>
      </div>

      <TaskDefinitionModal
        open={defModalOpen}
        defaultIMMode
        onClose={() => setDefModalOpen(false)}
        onCreated={(definition) => {
          setDefModalOpen(false);
          patch({ definitionId: definition.definitionId });
        }}
      />
    </main>
  );
};
