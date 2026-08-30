/**
 * 浏览器内核页（自旧「系统设置」拆分重写）。
 *
 * 浏览器任务的专用运行时:状态(检查中/已就绪/未安装/准备中 + 版本 + 平台)、
 * 安装/重试(平台无资产则禁用并说明)、进度订阅(download 按字节,verify/extract 满条)。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCw } from 'lucide-react';

import {
  messageText,
  presentationFromError,
  rawText,
  resolvePresentationText,
  type PresentationText,
} from '../../../i18n/presentationText';
import styles from '../deck.module.css';

interface KernelProgress {
  hostKey: string;
  phase: 'download' | 'verify' | 'extract' | 'done' | 'error';
  received?: number;
  total?: number;
  message?: string;
}

interface KernelStatus {
  hostKey: string;
  installed: boolean;
  hasAsset: boolean;
  version: string;
  progress?: KernelProgress;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export const KernelDesk: React.FC<{
  readonly onFlash: (text: PresentationText, tone?: 'halt' | 'hold' | 'calm') => void;
}> = ({ onFlash }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<KernelProgress | null>(null);
  const [fault, setFault] = useState<PresentationText | null>(null);
  const faultText = fault
    ? resolvePresentationText(fault, (key, values) => t(key, values))
    : null;

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const next = await window.piskie.pilot.environments.kernelStatus();
      const nextProgress = next.installed ? null : next.progress ?? null;
      setStatus(next);
      setProgress(nextProgress);
      setInstalling(nextProgress != null && ['download', 'verify', 'extract'].includes(nextProgress.phase));
      setFault(nextProgress?.phase === 'error'
        ? nextProgress.message
          ? rawText(nextProgress.message)
          : messageText('browserRuntime.installFailed')
        : null);
    } catch (error) {
      setFault(presentationFromError(error, messageText('browserRuntime.statusFailed')));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = window.piskie.pilot.environments.observeKernel((next) => {
      if (next.phase === 'done') {
        setProgress(null);
        setInstalling(false);
        void refresh();
        return;
      }
      if (next.phase === 'error') {
        setProgress(next);
        setInstalling(false);
        setFault(next.message
          ? rawText(next.message)
          : messageText('browserRuntime.installFailed'));
        return;
      }
      setProgress(next);
      setInstalling(true);
      setFault(null);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  const install = async (): Promise<void> => {
    if (installing) return;
    setInstalling(true);
    setFault(null);
    setProgress({ hostKey: status?.hostKey || '', phase: 'download' });
    try {
      const next = await window.piskie.pilot.environments.installKernel();
      if (!next.installed) {
        setStatus(next);
        setProgress(next.progress ?? null);
        setFault(messageText('browserRuntime.installFailed'));
        return;
      }
      setStatus(next);
      setProgress(null);
      onFlash(messageText('browserRuntime.installDone'));
    } catch (error) {
      setFault(presentationFromError(error, messageText('browserRuntime.installFailed')));
    } finally {
      setInstalling(false);
    }
  };

  const percent = progress?.total && progress.received != null
    ? Math.min(100, Math.max(0, Math.floor((progress.received / progress.total) * 100)))
    : 0;
  const phaseWord = progress?.phase === 'verify'
    ? t('browserRuntime.verifying')
    : progress?.phase === 'extract'
      ? t('browserRuntime.extracting')
      : t('browserRuntime.downloading');
  const stateWord = checking
    ? t('browserRuntime.checking')
    : status?.installed
      ? t('browserRuntime.ready')
      : installing
        ? t('browserRuntime.preparing')
        : t('browserRuntime.notInstalled');

  return (
    <>
      <div className={styles.deskHead}>
        <span className={styles.deskIdent}>
          <div className={styles.deskTitle}><span>{t('browserRuntime.title')}</span></div>
          <div className={styles.deskSub}>
            {t('browserRuntime.description')}
          </div>
        </span>
        <span className={styles.headSpring} />
        <span className={styles.headActs}>
          <button type="button" className={styles.btn} disabled={checking} onClick={() => void refresh()}>
            <RotateCw size={13} /> {t('common.refresh')}
          </button>
          {!status?.installed && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrime}`}
              disabled={checking || installing || !status || !status.hasAsset}
              onClick={() => void install()}
            >
              {status?.hasAsset === false
                ? t('browserRuntime.unavailable')
                : faultText
                  ? t('browserRuntime.retry')
                  : t('browserRuntime.install')}
            </button>
          )}
        </span>
      </div>

      <div className={styles.deskBody}>
        <div className={styles.slab}>
          <div className={styles.slabCap}>{t('browserRuntime.status')}</div>
          <div className={styles.trioGrid}>
            <div>
              <div className={styles.fieldTag}>{t('browserRuntime.status')}</div>
              <span
                className={styles.chip}
                data-state={status?.installed ? 'yes' : 'warn'}
                style={{ fontSize: 11 }}
              >
                {stateWord}
              </span>
            </div>
            <div>
              <div className={styles.fieldTag}>{t('browserRuntime.version')}</div>
              <span className={styles.monoNote} style={{ fontSize: 12 }}>
                {status?.version.replace(/^fpc-/, '') || '-'}
              </span>
            </div>
            <div>
              <div className={styles.fieldTag}>{t('browserRuntime.platform')}</div>
              <span className={styles.monoNote} style={{ fontSize: 12 }}>{status?.hostKey || '-'}</span>
            </div>
          </div>
        </div>

        {progress && progress.phase !== 'done' && progress.phase !== 'error' && (
          <div className={styles.slab}>
            <div className={styles.slabCap}>{phaseWord}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className={styles.meter}>
                <i style={{ inlineSize: `${progress.phase === 'download' ? percent : 100}%` }} />
              </span>
              {progress.received != null && (
                <span className={`${styles.rowNote} ${styles.monoNote}`}>
                  {megabytes(progress.received)}
                  {progress.total != null ? ` / ${megabytes(progress.total)}` : ''}
                </span>
              )}
            </div>
          </div>
        )}

        {faultText && <div className={styles.faultNote}>{faultText}</div>}
      </div>
    </>
  );
};
