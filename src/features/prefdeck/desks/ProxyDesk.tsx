/**
 * 代理配置页（重写）。
 *
 * 全局代理池:清单(状态点/协议徽章/URL/延迟或失败/编辑/删除两段/启用开关)、
 * 全部测试(并行,成败统计)。删除保护:被推理 Provider 引用时,确认文案列出引用数,
 * 删除后引用方回落直连。
 */

import React, { useEffect, useState } from 'react';
import { Pencil, Plus, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ProxyProfile } from '../../../../shared/electron-contracts/configuration';
import { Toggle } from '../../../components/task-definition/controls';
import { messageText, type PresentationText } from '../../../i18n/presentationText';
import { useInferenceStore } from '../../../store/inferenceStore';
import { useProxyStore } from '../../../store/proxyStore';
import styles from '../deck.module.css';

export interface ProxyDeskProps {
  readonly onEdit: (proxy?: ProxyProfile) => void;
  readonly onFlash: (text: PresentationText, tone?: 'halt' | 'hold' | 'calm') => void;
}

export const ProxyDesk: React.FC<ProxyDeskProps> = ({ onEdit, onFlash }) => {
  const { t } = useTranslation();
  const pool = useProxyStore((s) => s.config);
  const testResults = useProxyStore((s) => s.testResults);
  const testingIds = useProxyStore((s) => s.testingIds);
  const fetchPool = useProxyStore((s) => s.fetchConfig);
  const updateProxy = useProxyStore((s) => s.updateProxy);
  const removeProxy = useProxyStore((s) => s.removeProxy);
  const testProxy = useProxyStore((s) => s.testProxy);

  const [armedId, setArmedId] = useState<string | null>(null);
  const [armedHolderCount, setArmedHolderCount] = useState(0);

  useEffect(() => {
    void fetchPool();
  }, [fetchPool]);

  useEffect(() => {
    if (!armedId) return;
    const timer = setTimeout(() => {
      setArmedId(null);
      setArmedHolderCount(0);
    }, 4000);
    return () => clearTimeout(timer);
  }, [armedId]);

  const proxies = pool?.proxies ?? [];
  const enabledProxies = proxies.filter((proxy) => proxy.enabled);
  const testingAny = testingIds.size > 0;

  const testAll = async (): Promise<void> => {
    if (enabledProxies.length === 0) {
      onFlash(messageText('settings.proxy.noneEnabled'), 'hold');
      return;
    }
    const results = await Promise.allSettled(enabledProxies.map((proxy) => testProxy(proxy.id)));
    const passed = results.filter((r) => r.status === 'fulfilled' && r.value?.reachable).length;
    const failed = enabledProxies.length - passed;
    if (failed === 0) onFlash(messageText('settings.proxy.allReachable', { count: passed }));
    else onFlash(messageText('settings.proxy.testSummary', { passed, failed }), 'hold');
  };

  const kill = async (proxy: ProxyProfile): Promise<void> => {
    if (armedId !== proxy.id) {
      // 删除保护:统计推理 Provider 的引用
      const inferenceConfig = useInferenceStore.getState().config;
      const holders = Object.values(inferenceConfig?.providers ?? {})
        .filter((provider) => provider.connection.proxyId === proxy.id).length;
      setArmedId(proxy.id);
      setArmedHolderCount(holders);
      return;
    }
    setArmedId(null);
    setArmedHolderCount(0);
    if (await removeProxy(proxy.id)) onFlash(messageText('settings.proxy.deleted'));
    else onFlash(messageText('settings.proxy.deleteFailed'), 'halt');
  };

  return (
    <>
      <div className={styles.deskHead}>
        <span className={styles.deskIdent}>
          <div className={styles.deskTitle}><span>{t('settings.proxy.pageTitle')}</span></div>
          <div className={styles.deskSub}>{t('settings.proxy.pageSubtitle')}</div>
        </span>
        <span className={styles.headSpring} />
        <span className={styles.headActs}>
          {proxies.length > 0 && (
            <button
              type="button"
              className={styles.btn}
              disabled={testingAny || enabledProxies.length === 0}
              onClick={() => void testAll()}
            >
              <Zap size={13} />
              {testingAny ? t('settings.proxy.testing') : t('settings.proxy.testAll')}
            </button>
          )}
          <button type="button" className={`${styles.btn} ${styles.btnPrime}`} onClick={() => onEdit()}>
            <Plus size={13} /> {t('settings.proxy.add')}
          </button>
        </span>
      </div>

      <div className={styles.deskBody}>
        {proxies.length === 0 ? (
          <div className={styles.voidBox}>
            {t('settings.proxy.empty')}
            <button type="button" className={`${styles.btn} ${styles.btnPrime}`} onClick={() => onEdit()}>
              {t('settings.proxy.addFirst')}
            </button>
          </div>
        ) : (
          <div className={styles.slab}>
            <div className={styles.slabCap}>{t('settings.proxy.count', { count: proxies.length })}</div>
            {proxies.map((proxy) => {
              const outcome = testResults[proxy.id];
              const testing = testingIds.has(proxy.id);
              return (
                <div key={proxy.id} className={styles.rowLine} data-hover="true" data-dim={!proxy.enabled}>
                  <span
                    className={styles.twigDot}
                    style={proxy.enabled ? undefined : { background: 'transparent', boxShadow: 'inset 0 0 0 1px currentColor', opacity: 0.5 }}
                  />
                  <span className={styles.rowMain}>
                    <span className={styles.rowName}>
                      <span>{proxy.name}</span>
                      <span className={styles.chip} data-state="prime">{proxy.protocol.toUpperCase()}</span>
                    </span>
                    <span className={`${styles.rowNote} ${styles.monoNote}`}>
                      {proxy.protocol}://{proxy.host}:{proxy.port}
                    </span>
                  </span>

                  {testing && <span className={styles.chip} data-state="warn">{t('settings.proxy.testing')}</span>}
                  {!testing && outcome && (outcome.reachable ? (
                    <span
                      className={styles.elapsedTag}
                      title={outcome.externalIp ? t('settings.proxy.exitIp', { ip: outcome.externalIp }) : undefined}
                    >
                      {t('settings.proxy.reachable', { latency: outcome.latencyMs })}
                    </span>
                  ) : (
                    <span className={styles.chip} data-state="no" title={outcome.error}>{t('settings.proxy.failed')}</span>
                  ))}

                  <span className={styles.rowActs}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnQuiet}`}
                      disabled={testing}
                      onClick={() => void testProxy(proxy.id)}
                    >
                      {t('settings.proxy.test')}
                    </button>
                    <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={() => onEdit(proxy)}>
                      <Pencil size={11} /> {t('settings.proxy.edit')}
                    </button>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnQuiet} ${styles.btnRisk} ${armedId === proxy.id ? styles.btnArmed : ''}`}
                      title={armedId === proxy.id && armedHolderCount > 0
                        ? t('settings.proxy.referencedWarning', { count: armedHolderCount })
                        : undefined}
                      onClick={() => void kill(proxy)}
                    >
                      {armedId === proxy.id ? t('settings.proxy.confirmDelete') : t('common.delete')}
                    </button>
                  </span>
                  <Toggle
                    on={proxy.enabled}
                    ariaLabel={t('settings.proxy.enabledAria', { name: proxy.name })}
                    onFlip={(enabled) => void updateProxy(proxy.id, { enabled })}
                  />
                </div>
              );
            })}
            {armedId && armedHolderCount > 0 && (
              <div className={`${styles.fieldNote} ${styles.faultNote}`}>
                {t('settings.proxy.confirmDeleteAgain', {
                  warning: t('settings.proxy.referencedWarning', { count: armedHolderCount }),
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
};
