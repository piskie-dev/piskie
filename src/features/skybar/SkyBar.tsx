/**
 * 天际栏:与模块彻底解耦的全局系统栏。
 *
 * 全路由共用一条栏，不显示模块标题；模块身份由导航坞/棱镜承担。
 * 左=品牌 + 任务广播位(busy 会话轮播头条,多任务 6 秒轮换 + 「+N」签);
 * 右=token 汇总遥测 + 灯签族(授权/待批/错误/全部中断/内核)+ 系统时钟。
 * 整条栏是窗口拖拽区;macOS 红绿灯与栏同层,由窗口 trafficLightPosition 垂直对中。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { canPause } from '@shared/types/agent-control';
import { useAgentControl, useRendererRuntime } from '../../renderer-runtime/hooks';
import { useIncidentStore } from '../../store';
import { IncidentIndicator, selectVisibleIncidents } from '../incidents';
import { useMessagingStore } from '../../store/messagingStore';
import { PendingPopover } from '../imdossier/PendingPopover';
import KernelDownloadIndicator from '../../components/KernelDownloadIndicator';
import { createConsoleHeaderAction } from '../console/shell/headerAction';
import { isMacOSPlatform } from '../../utils/platform';
import { absorbTargets, sessionTokenTally } from './tally';
import styles from './skybar.module.css';

import logo64 from '/logo-64.png';

function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(2)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`;
  return String(total);
}

function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function formatClock(at: number): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** 头条轮换周期(毫秒) */
const CAST_ROTATE_MS = 6000;

export const SkyBar: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const runtime = useRendererRuntime();
  const agentsById = useAgentControl((snapshot) => snapshot.agentsById);
  const targetsById = useAgentControl((snapshot) => snapshot.targetsById);
  const approvalCount = useAgentControl((snapshot) => snapshot.header.approvalCount);
  const busyCount = useAgentControl((snapshot) => snapshot.header.busyCount);
  const senderAuthorizationCount = useMessagingStore(
    (state) => state.senderAuthorizationRequests.length,
  );
  const visibleIncidentCount = useIncidentStore(
    (state) => selectVisibleIncidents(state.incidents).length,
  );

  /* 纯加法汇总:幂等吸收,同一快照重复吸收增量为零 */
  const tokenTotal = useMemo(() => absorbTargets(sessionTokenTally, targetsById), [targetsById]);

  const [now, setNow] = useState(() => Date.now());
  const [interruptNote, setInterruptNote] = useState<string | null>(null);
  const noteTimer = useRef<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
  }, []);

  /* 广播位:在忙(运行中/等输入)的会话轮流坐头条 */
  const broadcasting = useMemo(
    () => Object.values(agentsById).filter((agent) => canPause(agent)),
    [agentsById],
  );
  const castIndex = broadcasting.length > 0
    ? Math.floor(now / CAST_ROTATE_MS) % broadcasting.length
    : 0;
  const headline = broadcasting[castIndex];

  const goConsole = (): void => {
    navigate('/console');
  };

  const handleInterruptAll = async (): Promise<void> => {
    const success = await runtime.agentCommands.interruptAll();
    if (success) return;
    setInterruptNote(t('console.interruptBatchIncomplete'));
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setInterruptNote(null), 4000);
  };

  return (
    <header className={styles.bar} data-mac={isMacOSPlatform() ? 'true' : undefined}>
      <div className={styles.brand}>
        <img src={logo64} alt="piskie" className="app-logo-adaptive" />
        <b>piskie</b>
      </div>

      {headline && (
        <button
          type="button"
          key={`${headline.agentId}:${castIndex}`}
          className={`${styles.cast} ${styles.castSwap}`}
          onClick={goConsole}
        >
          <span className={styles.castDot} aria-hidden />
          <span className={styles.castName}>
            {headline.runConfig.name?.trim() || t('skybar.unnamedTask')}
          </span>
          {headline.activeStartedAt !== undefined && (
            <span className={styles.castTime}>
              {t('skybar.thisRun')} {formatSpan(now - headline.activeStartedAt)}
            </span>
          )}
          {broadcasting.length > 1 && (
            <span className={styles.castMore}>+{broadcasting.length - 1}</span>
          )}
        </button>
      )}

      <span className={styles.spring} />

      <span className={styles.tele}>
        <span className={styles.unit}>{t('skybar.tokenTotal')}</span>
        <b>{formatTokens(tokenTotal)}</b>
      </span>

      <div className={styles.deck}>
        <KernelDownloadIndicator />

        {senderAuthorizationCount > 0 && (
          <PendingPopover jumpHint="#/messaging" align="end" />
        )}

        {approvalCount > 0 && (
          <button
            type="button"
            className={styles.lamp}
            data-tone="hold"
            onClick={() => navigate('/console', {
              state: { consoleAction: createConsoleHeaderAction({ kind: 'approval' }) },
            })}
          >
            <i aria-hidden />
            {t('console.approvalsWaiting', { count: approvalCount })}
          </button>
        )}

        {visibleIncidentCount > 0 && (
          <IncidentIndicator
            onFocusTarget={(target) => navigate('/console', {
              state: { consoleAction: createConsoleHeaderAction({ kind: 'error', target }) },
            })}
          />
        )}

        {busyCount > 0 && (
          <button
            type="button"
            className={`${styles.lamp} ${styles.lampStop}`}
            data-tone="halt"
            onClick={handleInterruptAll}
          >
            <i aria-hidden />
            {t('console.interruptAll')} ({busyCount})
          </button>
        )}

        {interruptNote && <span className={styles.note}>{interruptNote}</span>}
      </div>

      <span className={styles.clock}>{formatClock(now)}</span>
    </header>
  );
};
