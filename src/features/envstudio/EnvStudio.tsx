/**
 * EnvStudio —— 浏览器环境「导播台」（替代 src/pages/Browser）
 *
 * Lumen 语言：近黑舞台、无边框明度分层、光是唯一装饰。
 * 结构：Topbar（quiet metadata + 动作）→ Switchboard（Program + Preview）→ Footline。
 * 零环境时是粒子 orb 空态舞台。
 *
 * 覆盖主视图、启停、显示窗口、平铺、删除、实时画面，以及新建/编辑和代理池。
 * Cookie 管理尚未接入当前界面。
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BrowserEnvironment } from '@shared/types';
import { useFleet, useOccupancies, proxyLabelOf, identityLineOf } from './data/fleet';
import { Switchboard } from './board/Switchboard';
import { ForgeSheet } from './sheets/ForgeSheet';
import { ProxyDepot } from './sheets/ProxyDepot';
import { ActPill } from './glyphs/ActPill';
import { GlowDot } from './glyphs/GlowDot';
import { ThinkOrb } from './glyphs/ThinkOrb';
import {
  messageText,
  resolvePresentationText,
  type PresentationText,
} from '../../i18n/presentationText';
import styles from './studio.module.css';

type StudioSheet =
  | { kind: 'forge'; env: BrowserEnvironment | null }
  | { kind: 'depot' }
  | null;

const EnvStudio: React.FC = () => {
  const { t } = useTranslation();
  const fleet = useFleet();
  const occupancies = useOccupancies();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<PresentationText | null>(null);
  const [sheet, setSheet] = useState<StudioSheet>(null);

  const runningCount = useMemo(
    () => fleet.envs.filter((env) => env.status === 'running').length,
    [fleet.envs],
  );

  const program = fleet.envs.find((env) => env.id === selectedId) ?? fleet.envs[0] ?? null;

  const withBusy = useCallback(async (envId: string, run: () => Promise<unknown>) => {
    setPendingId(envId);
    try {
      await run();
    } finally {
      setPendingId(null);
    }
  }, []);

  const handleIgnite = useCallback(
    (envId: string) => void withBusy(envId, () => fleet.ignite(envId)),
    [fleet, withBusy],
  );
  const handleExtinguish = useCallback(
    (envId: string) => void withBusy(envId, () => fleet.extinguish(envId)),
    [fleet, withBusy],
  );
  const handleRelight = useCallback(
    (envId: string) =>
      void withBusy(envId, async () => {
        const stopped = await fleet.extinguish(envId);
        if (stopped) await fleet.ignite(envId);
      }),
    [fleet, withBusy],
  );
  const handleSurface = useCallback(
    (envId: string) =>
      void fleet.surface(envId).then((shown) => {
        if (!shown) setNotice(messageText('environmentUi.studio.windowPermissionRequired'));
      }),
    [fleet],
  );
  const handleScrap = useCallback(
    (envId: string) =>
      void fleet.scrap(envId).then((ok) => {
        if (ok && selectedId === envId) setSelectedId(null);
      }),
    [fleet, selectedId],
  );

  const handleForge = useCallback((env: BrowserEnvironment | null) => {
    setSheet({ kind: 'forge', env });
  }, []);
  const handleDepot = useCallback(() => {
    setSheet({ kind: 'depot' });
  }, []);
  const closeSheet = useCallback(() => setSheet(null), []);
  const handleSaved = useCallback(() => {
    setSheet(null);
    void fleet.reload();
  }, [fleet]);

  // 画面失联判定 → 核对环境列表（环境可能已在别处停止）；节流防多块画面同时失联的连环刷
  const lapseCheckedAt = useRef(0);
  const handleLapse = useCallback(() => {
    const at = Date.now();
    if (at - lapseCheckedAt.current < 5_000) return;
    lapseCheckedAt.current = at;
    void fleet.reload();
  }, [fleet]);

  const present = (value: PresentationText): string => (
    resolvePresentationText(value, (key, values) => t(key, values ?? {}))
  );
  const kernelPhase = fleet.kernel?.busyPhase === 'download'
    ? t('environmentUi.studio.kernelDownloading')
    : fleet.kernel?.busyPhase === 'verify'
      ? t('environmentUi.studio.kernelVerifying')
      : fleet.kernel?.busyPhase === 'extract'
        ? t('environmentUi.studio.kernelExtracting')
        : fleet.kernel?.busyPhase === 'error'
          ? fleet.kernel.busyMessage ?? t('environmentUi.studio.kernelFailed')
          : t('environmentUi.studio.kernelInstalling');
  const kernelLine = fleet.kernel
    ? fleet.kernel.busyPhase && fleet.kernel.busyPhase !== 'done'
      ? t('environmentUi.studio.kernelWorking', { phase: kernelPhase })
      : t('environmentUi.studio.kernelVersion', {
          version: fleet.kernel.version || '?',
          status: fleet.kernel.installed
            ? t('environmentUi.studio.kernelReady')
            : t('environmentUi.studio.kernelNotInstalled'),
        })
    : t('environmentUi.studio.kernelUnknown');

  return (
    <div className={styles.studio}>
      <div className={styles.grain} aria-hidden="true" />
      <div className={styles.deck}>
        <header className={styles.topbar}>
          <span className={styles.crumb}>{t('environmentUi.studio.title')}</span>
          <span className={styles.meta}>
            {fleet.envs.length > 0 ? (
              <>
                <b>{t('environmentUi.studio.totalCount', { count: fleet.envs.length })}</b>
                {' · '}
                <b>{t('environmentUi.studio.runningCount', { count: runningCount })}</b>
              </>
            ) : (
              t('environmentUi.studio.emptyCount')
            )}
          </span>
          <span className={styles.actions}>
            <ActPill tone="hush" onClick={handleDepot}>
              {t('environmentUi.studio.proxyPool')}
            </ActPill>
            <ActPill tone="prime" onClick={() => handleForge(null)}>
              {t('environmentUi.studio.createEnvironment')}
            </ActPill>
          </span>
        </header>

        {fleet.loading ? null : fleet.envs.length === 0 ? (
          <section className={styles.voidStage}>
            <div>
              <div className={styles.orbWrap}>
                <span className={styles.orbHalo} aria-hidden="true" />
                <ThinkOrb />
              </div>
              <h2 className={styles.voidTitle}>{t('environmentUi.studio.emptyTitle')}</h2>
              <p className={styles.voidSay}>
                {t('environmentUi.studio.emptyDescription')}
              </p>
              <ActPill tone="prime" onClick={() => handleForge(null)}>
                {t('environmentUi.studio.createFirst')}
              </ActPill>
              <div className={styles.footline} style={{ justifyContent: 'center' }}>
                <span>
                  <GlowDot mood={fleet.kernel?.installed ? 'live' : 'hold'} size={5} /> {kernelLine}
                </span>
              </div>
            </div>
          </section>
        ) : (
          <Switchboard
            envs={fleet.envs}
            occupancies={occupancies}
            selectedId={program?.id ?? null}
            busyId={pendingId}
            onSelect={setSelectedId}
            onIgnite={handleIgnite}
            onExtinguish={handleExtinguish}
            onRelight={handleRelight}
            onSurface={handleSurface}
            onForge={handleForge}
            onScrap={handleScrap}
            onLapse={handleLapse}
          />
        )}

        {fleet.envs.length > 0 && (
          <footer className={styles.footline}>
            <span className={fleet.kernel?.busyPhase && fleet.kernel.busyPhase !== 'done' ? styles.kernelBusy : undefined}>
              {kernelLine}
            </span>
            {program && (
              <span>
                {proxyLabelOf(fleet.proxies, program.proxyId, t)} · {identityLineOf(program, t)}
              </span>
            )}
            {(notice ?? fleet.fault) && (
              <span className={styles.footRight}>{present(notice ?? fleet.fault!)}</span>
            )}
          </footer>
        )}
      </div>

      {sheet?.kind === 'forge' && (
        <ForgeSheet
          env={sheet.env}
          proxies={fleet.proxies}
          kernelBuild={fleet.kernel?.version ?? null}
          onClose={closeSheet}
          onSaved={handleSaved}
        />
      )}
      {sheet?.kind === 'depot' && <ProxyDepot onClose={closeSheet} onChanged={() => void fleet.reload()} />}
    </div>
  );
};

export default EnvStudio;
