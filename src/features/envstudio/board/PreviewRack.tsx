/**
 * EnvStudio · 预监列（PREVIEW）
 *
 * 全部环境的实时小画面/金属盘封面竖排，点击切上主屏；列尾「＋ 新建环境」。
 * 运行中的画面 3s 级刷新——预监列本身就是并发监视条。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import type { BrowserEnvironment } from '@shared/types';
import type { Occupancy } from '@shared/types/occupancy';
import { occupantOf } from '../data/fleet';
import { GlowDot } from '../glyphs/GlowDot';
import { ThinkOrb } from '../glyphs/ThinkOrb';
import { LiveGlimpse } from '../glyphs/LiveGlimpse';
import { moodOf, lastUsedStamp } from './signal';
import styles from '../studio.module.css';

const PREVIEW_FRAME_MS = 3_000;

function statOf(
  env: BrowserEnvironment,
  occupant: Occupancy | undefined,
  translate: (key: string, values?: Record<string, number>) => string,
): string {
  if (occupant) return translate('environmentUi.preview.agentOccupied');
  if (env.status !== 'running') return lastUsedStamp(env, translate);
  return env.restartRequired
    ? translate('environmentUi.preview.restartPending')
    : translate('environmentUi.preview.live');
}

interface PreviewRackProps {
  envs: BrowserEnvironment[];
  occupancies: Occupancy[];
  selectedId: string | null;
  onSelect(envId: string): void;
  onForgeNew(): void;
  /** 某块预监画面失联判定时核对环境状态 */
  onLapse(): void;
}

export const PreviewRack: React.FC<PreviewRackProps> = ({
  envs,
  occupancies,
  selectedId,
  onSelect,
  onForgeNew,
  onLapse,
}) => {
  const { t } = useTranslation();

  return (
  <aside className={styles.rackSide}>
    <div className={styles.rackCap}>{t('environmentUi.preview.title')}</div>
    <div className={styles.rack}>
      {envs.map((env) => {
        const occupant = occupantOf(occupancies, env.id);
        const running = env.status === 'running';
        const active = env.id === selectedId;
        return (
          <button
            type="button"
            key={env.id}
            className={`${styles.pane} ${styles.pv}${active ? ` ${styles.pvOn}` : ''}`}
            aria-current={active || undefined}
            onClick={() => onSelect(env.id)}
          >
            <span className={styles.pvView}>
              {running ? (
                <LiveGlimpse
                  browserId={env.currentBrowserId}
                  intervalMs={PREVIEW_FRAME_MS}
                  mood={moodOf(env)}
                  caption={statOf(env, occupant, t)}
                  alt={t('environmentUi.preview.imageAlt', { name: env.name })}
                  onLapse={onLapse}
                />
              ) : (
                <span className={styles.pvBrief}>
                  <span className={styles.pvBriefDisc}>
                    <ThinkOrb size={40} speed={0.0022} punch />
                  </span>
                  <span className={styles.pvBriefBody}>
                    <span className={styles.pvBriefCap}>
                      {env.purpose
                        ? t('environmentUi.preview.purpose')
                        : t('environmentUi.preview.purposeMissing')}
                    </span>
                    <p className={`${styles.pvBriefText}${env.purpose ? '' : ` ${styles.purposeVoid}`}`}>
                      {env.purpose || t('environmentUi.preview.addPurpose')}
                    </p>
                  </span>
                </span>
              )}
            </span>
            <span className={styles.pvLab}>
              <GlowDot mood={moodOf(env)} size={6} />
              <span className={styles.pvName}>{env.name}</span>
              <span className={styles.pvStat}>{statOf(env, occupant, t)}</span>
            </span>
          </button>
        );
      })}

      <button type="button" className={`${styles.pv} ${styles.pvAdd}`} onClick={onForgeNew}>
        + {t('environmentUi.preview.addEnvironment')}
      </button>
    </div>
  </aside>
  );
};
