/**
 * 待授权铃（双玻璃名册档案）。
 *
 * 铃 + 锚定浮层:列出全部待授权请求(Bot/渠道/私聊|群聊/配对码/相对时间),
 * 就地授权/拒绝(store 乐观移除)。`.popWrap` 自带皮肤变量,
 * 终局阶段可独立挂到 Console 顶栏替换旧 SenderAuthorizationPopover
 * (届时经 `jumpHint` 提供"前往 IM 渠道"跳链)。
 */

import React, { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useMessagingStore } from '../../store/messagingStore';
import { resolvePresentationText } from '../../i18n/presentationText';
import { sinceText } from './data/channel-facts';
import styles from './dossier.module.css';

export interface PendingPopoverProps {
  /** 挂在 IM 页之外时给跳链(hash),浮层眉标出现"前往 IM 渠道" */
  readonly jumpHint?: string;
  /** 浮层对齐:锚点靠屏幕右缘(如 Layout 顶栏)时用 'end' */
  readonly align?: 'start' | 'end';
}

export const PendingPopover: React.FC<PendingPopoverProps> = ({ jumpHint, align = 'start' }) => {
  const { t } = useTranslation();
  const requests = useMessagingStore((s) => s.senderAuthorizationRequests);
  const approve = useMessagingStore((s) => s.approveSenderAuthorization);
  const reject = useMessagingStore((s) => s.rejectSenderAuthorization);
  const present = (value: ReturnType<typeof sinceText>): string => (
    resolvePresentationText(value, (key, values) => t(key, values ?? {}))
  );

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  return (
    <span ref={wrapRef} className={styles.popWrap}>
      <button
        type="button"
        className={styles.orb}
        aria-expanded={open}
        aria-label={t('imPlugin.senderAuthorization')}
        title={`${t('imPlugin.senderAuthorization')} · ${requests.length}`}
        onClick={() => setOpen((current) => !current)}
      >
        <Bell size={14} />
        {requests.length > 0 && <span className={styles.orbCue} />}
      </button>
      {open && (
        <div
          className={styles.popCard}
          data-align={align}
          role="dialog"
          aria-label={t('imPlugin.senderAuthorization')}
        >
          <div className={styles.popCap}>
            {t('imPlugin.senderAuthorization')} · {requests.length}
            <span className={styles.capSpring} />
            {jumpHint && (
              <button
                type="button"
                className={styles.stepLink}
                onClick={() => {
                  window.location.hash = jumpHint;
                  setOpen(false);
                }}
              >
                {t('imPlugin.authorization.openMessagingHub')} →
              </button>
            )}
          </div>
          <div className={styles.popBody}>
            {requests.length === 0 ? (
              <div className={styles.popEmpty}>{t('imPlugin.authorization.noPendingReviews')}</div>
            ) : (
              requests.map((request) => (
                <div key={request.id} className={styles.askRow}>
                  <span className={styles.askWho} title={request.senderId}>
                    <b>{request.senderName ?? request.senderId}</b>
                    {' · '}
                    {request.botName}
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
                    onClick={() => void approve(request.id)}
                  >
                    {t('imPlugin.approve')}
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnQuiet}`}
                    onClick={() => void reject(request.id)}
                  >
                    {t('imPlugin.reject')}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </span>
  );
};
