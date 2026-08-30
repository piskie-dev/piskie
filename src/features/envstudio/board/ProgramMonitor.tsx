/**
 * EnvStudio · 主屏（PROGRAM）
 *
 * 选中环境的大画面：运行中 = 1s 级实时快照 + beam 流光边；空闲 = 待命档案
 * （用途 / 已登录站点 / 上次使用）。两态共用底部悬浮字幕层，操作位恒定。
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BrowserEnvironment } from '@shared/types';
import type { Occupancy } from '@shared/types/occupancy';
import { ActPill } from '../glyphs/ActPill';
import { GlowDot } from '../glyphs/GlowDot';
import { moodOf, lastUsedLine, uptimeLine } from './signal';
import { ThinkOrb } from '../glyphs/ThinkOrb';
import { useLoginTrail } from '../data/loginTrail';
import { resolveSiteFace } from '../data/siteAtlas';
import { LiveGlimpse } from '../glyphs/LiveGlimpse';
import styles from '../studio.module.css';

const PROGRAM_FRAME_MS = 1_000;

interface ProgramMonitorProps {
  env: BrowserEnvironment;
  occupant: Occupancy | undefined;
  busy: boolean;
  onIgnite(): void;
  onExtinguish(): void;
  onRelight(): void;
  onSurface(): void;
  onForge(): void;
  onScrap(): void;
  /** 画面失联判定时核对环境状态 */
  onLapse(): void;
}

export const ProgramMonitor: React.FC<ProgramMonitorProps> = ({
  env,
  occupant,
  busy,
  onIgnite,
  onExtinguish,
  onRelight,
  onSurface,
  onForge,
  onScrap,
  onLapse,
}) => {
  const { t } = useTranslation();
  const running = env.status === 'running';
  const locked = running || !!occupant;
  const mood = moodOf(env);
  // 运行时长计时器：1s 一跳（主屏本就每秒换帧重渲染，计时器无额外成本）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  // 运行期自动采集 cookie 域名（只存域名），空闲时展示上次运行的登录痕迹
  const trail = useLoginTrail(env);
  const shownSites = trail?.sites.slice(0, 6) ?? [];
  const moreSites = (trail?.sites.length ?? 0) - shownSites.length;

  // 删除确认：第一次点击进入待确认态，3s 未确认自动复位
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3_000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const stateLine = occupant ? (
    <span className={styles.overlayState}>
      {t('environmentUi.monitor.agentOccupied', { name: occupant.occupantName })}
    </span>
  ) : env.restartRequired ? (
    <span className={styles.overlayState} style={{ color: 'var(--st-hold)' }}>
      {t('environmentUi.monitor.restartRequired')}
    </span>
  ) : (
    <span className={`${styles.overlayState} ${styles.shimmer}`}>
      {t('environmentUi.monitor.running')}
    </span>
  );

  return (
    <section className={`${styles.pane} ${styles.program}${running ? ` ${styles.beam}` : ''}${
      running && env.restartRequired ? ` ${styles.beamHold}` : ''
    }`}>
      <div className={styles.programView}>
        {running ? (
          <>
            <LiveGlimpse
              browserId={env.currentBrowserId}
              intervalMs={PROGRAM_FRAME_MS}
              mood={mood}
              caption={uptimeLine(env, now)}
              alt={t('environmentUi.monitor.liveImageAlt', { name: env.name })}
              hud
              onLapse={onLapse}
            />
            <span className={styles.stageOverlay}>
              <span className={styles.overlayLead}>
                <span className={styles.overlayTitle}>
                  <GlowDot mood={mood} />
                  <span className={styles.overlayName}>{env.name}</span>
                  {stateLine}
                </span>
                <p className={`${styles.overlayUse}${env.purpose ? '' : ` ${styles.useVoid}`}`}>
                  {env.purpose || t('environmentUi.monitor.purposeMissing')}
                </p>
              </span>
              <span className={styles.overlayOps}>
                <ActPill tone="prime" onClick={onSurface}>
                  {t('environmentUi.monitor.showWindow')}
                </ActPill>
                {env.restartRequired && (
                  <ActPill tone="prime" disabled={busy} onClick={onRelight}>
                    {t('environmentUi.monitor.restartNow')}
                  </ActPill>
                )}
                <ActPill tone="halt" onClick={onExtinguish} disabled={busy}>
                  {t('environmentUi.monitor.stop')}
                </ActPill>
              </span>
            </span>
          </>
        ) : (
          <>
            <span className={styles.idleScene}>
              <span className={styles.idleOrbDeco} aria-hidden="true">
                <ThinkOrb size={230} speed={0.0015} />
              </span>
              <span className={styles.dossier}>
                <span className={styles.dossierCap}>
                  {t('environmentUi.monitor.standby')}
                  <span className={styles.dossierCapTime}> · {lastUsedLine(env, t)}</span>
                </span>
                <p className={`${styles.dossierText}${env.purpose ? '' : ` ${styles.purposeVoid}`}`}>
                  {env.purpose || t('environmentUi.monitor.purposeMissing')}
                </p>
                <span className={styles.trailLine}>
                  {shownSites.length > 0 ? (
                    <>
                      <span className={styles.trailWord}>{t('environmentUi.monitor.signedInSites')}</span>
                      {shownSites.map((site) => {
                        const face = resolveSiteFace(site.host);
                        return (
                          <span key={site.host} className={styles.siteChip} title={site.host}>
                            <span className={styles.siteBadge}>{face.badge}</span>
                            {face.name ? (
                              <span className={styles.siteName}>{face.name}</span>
                            ) : (
                              <span className={styles.siteHost}>{face.host}</span>
                            )}
                          </span>
                        );
                      })}
                      {moreSites > 0 && (
                        <span className={`${styles.siteChip} ${styles.siteChipMore}`}>+{moreSites}</span>
                      )}
                    </>
                  ) : (
                    <span className={styles.trailWord}>{t('environmentUi.monitor.loginTrailEmpty')}</span>
                  )}
                </span>
              </span>
            </span>
            <span className={styles.stageOverlay}>
              <span className={styles.overlayLead}>
                <span className={styles.overlayTitle}>
                  <GlowDot mood={mood} />
                  <span className={styles.overlayName}>{env.name}</span>
                  <span className={styles.overlayState}>{t('environmentUi.monitor.idle')}</span>
                </span>
              </span>
              <span className={styles.overlayOps}>
                <ActPill tone="prime" onClick={onIgnite} disabled={busy}>
                  {t('environmentUi.monitor.start')}
                </ActPill>
                <ActPill
                  tone="hush"
                  onClick={onForge}
                  disabled={locked}
                  title={locked ? t('environmentUi.monitor.stopBeforeEdit') : undefined}
                >
                  {t('environmentUi.monitor.edit')}
                </ActPill>
                <ActPill
                  tone="halt"
                  disabled={locked}
                  title={locked ? t('environmentUi.monitor.stopBeforeEdit') : undefined}
                  onClick={() => {
                    if (armed) {
                      setArmed(false);
                      onScrap();
                    } else {
                      setArmed(true);
                    }
                  }}
                >
                  {armed
                    ? t('environmentUi.monitor.confirmDelete')
                    : t('environmentUi.monitor.delete')}
                </ActPill>
              </span>
            </span>
          </>
        )}
      </div>

    </section>
  );
};
