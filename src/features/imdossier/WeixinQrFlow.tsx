/**
 * weixin 扫码登录流（双玻璃名册档案 · 七阶段）。
 *
 * 阶段:boot(获取二维码) → scan(展示扫码) → verify(要验证码) →
 * submitting(提交中) / expired(过期可重取) / blocked(验证码被限) / fault(错误)。
 * 语义红线:验证码 `/^\d{1,8}$/`;代际计数丢弃过期回调;卸载即 cancelQrLogin
 * (已连接成功则不再取消);连接成功回调 `onConnected(alreadyConnected)`,
 * 启动编排(自动启动 Bot)归宿主。
 *
 * 流程状态机收在 `createQrFlow` 纯工厂里(不碰 React),组件只做视图与接线,
 * 规避 React Compiler 对渲染期 ref 读写与手工记忆化的限制。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resolvePresentationText } from '../../i18n/presentationText';
import { useMessagingStore } from '../../store/messagingStore';
import { createQrFlow, type QrView } from './data/qr-flow';
import styles from './dossier.module.css';

export interface WeixinQrFlowProps {
  readonly botId: string;
  readonly channelType: string;
  /** 重新登录场景传 true(宿主已先停 Bot) */
  readonly force: boolean;
  readonly onConnected: (alreadyConnected: boolean) => void;
  readonly onDismiss: () => void;
}

export const WeixinQrFlow: React.FC<WeixinQrFlowProps> = ({
  botId,
  channelType,
  force,
  onConnected,
  onDismiss,
}) => {
  const { t } = useTranslation();
  const qrStart = useMessagingStore((s) => s.loginWithQrStart);
  const qrWait = useMessagingStore((s) => s.loginWithQrWait);
  const qrSubmit = useMessagingStore((s) => s.loginWithQrSubmitCode);
  const qrCancel = useMessagingStore((s) => s.loginWithQrCancel);

  const [view, setView] = useState<QrView>({ phase: 'boot', qr: null });
  const [code, setCode] = useState('');
  const flowRef = useRef<ReturnType<typeof createQrFlow> | null>(null);
  const onConnectedRef = useRef(onConnected);

  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  useEffect(() => {
    const flow = createQrFlow({
      botId,
      channelType,
      start: qrStart,
      wait: qrWait,
      submit: qrSubmit,
      cancel: qrCancel,
      render: setView,
      connected: (already) => onConnectedRef.current(already),
    });
    flowRef.current = flow;
    flow.begin(force);
    return () => {
      flowRef.current = null;
      flow.dispose();
    };
  }, [botId, channelType, force, qrStart, qrWait, qrSubmit, qrCancel]);

  const presentedWord = view.word
    ? resolvePresentationText(view.word, (key, values) => t(key, values ?? {}))
    : '';

  return (
    <div className={styles.qrDock}>
      {(view.phase === 'boot' || view.phase === 'scan' || view.phase === 'verify' || view.phase === 'submitting') && (
        <div className={styles.qrShell}>
          {view.qr ? <img src={view.qr} alt={t('imPlugin.qr.imageAlt')} /> : <span className={styles.qrPulse} />}
        </div>
      )}

      {presentedWord && (
        <div
          className={styles.qrWord}
          data-tone={
            view.phase === 'fault' || view.phase === 'blocked'
              ? 'halt'
              : view.phase === 'expired' || view.phase === 'verify'
                ? 'hold'
                : undefined
          }
        >
          {presentedWord}
        </div>
      )}
      {view.phase === 'boot' && <div className={styles.qrWord}>{t('imPlugin.qr.preparingImage')}</div>}
      {view.phase === 'scan' && !presentedWord && (
        <div className={styles.qrWord}>{t('imPlugin.qr.scanPrompt')}</div>
      )}

      {(view.phase === 'verify' || view.phase === 'submitting') && (
        <div className={styles.codeRow}>
          <input
            className={styles.textIn}
            value={code}
            maxLength={8}
            inputMode="numeric"
            placeholder={t('imPlugin.qr.codeInputHint')}
            disabled={view.phase === 'submitting'}
            onChange={(event) => setCode(event.target.value.trim())}
            onKeyDown={(event) => {
              if (event.key === 'Enter') flowRef.current?.submitCode(code, view.qr);
            }}
          />
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrime}`}
            disabled={view.phase === 'submitting'}
            onClick={() => flowRef.current?.submitCode(code, view.qr)}
          >
            {view.phase === 'submitting'
              ? t('imPlugin.qr.checkingCode')
              : t('imPlugin.qr.submitCode')}
          </button>
        </div>
      )}

      {(view.phase === 'expired' || view.phase === 'fault') && (
        <button type="button" className={styles.btn} onClick={() => flowRef.current?.begin(false)}>
          {t('imPlugin.qr.fetchAnother')}
        </button>
      )}

      <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={onDismiss}>
        {t('common.cancel')}
      </button>
    </div>
  );
};
