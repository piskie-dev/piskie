/**
 * EnvStudio · Depot（全局代理池）
 *
 * 功能对齐旧「全局代理池」弹窗：列表、添加/编辑、连接测试（延迟/出口 IP/失败原因）、
 * 删除（被环境或 Inference 引用时后端拒绝，错误就地显示）。
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProxyProfile, ProxyProtocol } from '@shared/types/proxy';
import { SheetShell } from './SheetShell';
import { ActPill } from '../glyphs/ActPill';
import {
  messageText,
  rawText,
  resolvePresentationText,
  type PresentationText,
} from '../../../i18n/presentationText';
import styles from '../studio.module.css';

interface ProbeReadout {
  reachable: boolean;
  latencyMs?: number;
  externalIp?: string;
  error?: string;
}

interface DepotDraft {
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
}

const EMPTY_DRAFT: DepotDraft = { name: '', protocol: 'http', host: '', port: '', username: '', password: '' };

interface ProxyDepotProps {
  onClose(): void;
  onChanged(): void;
}

export const ProxyDepot: React.FC<ProxyDepotProps> = ({ onClose, onChanged }) => {
  const { t } = useTranslation();
  const [proxies, setProxies] = useState<ProxyProfile[]>([]);
  const [probes, setProbes] = useState<Record<string, ProbeReadout>>({});
  const [probing, setProbing] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<DepotDraft>(EMPTY_DRAFT);
  const [fault, setFault] = useState<PresentationText | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const config = await window.piskie.configuration.proxy.read();
      setProxies(config?.proxies ?? []);
    } catch (error) {
      setFault(error instanceof Error
        ? rawText(error.message)
        : messageText('environmentUi.proxyDepot.loadFailed'));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!armedId) return;
    const timer = window.setTimeout(() => setArmedId(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [armedId]);

  const beginCreate = () => {
    setDraft(EMPTY_DRAFT);
    setEditingId('new');
    setFault(null);
  };

  const beginEdit = (entry: ProxyProfile) => {
    setDraft({
      name: entry.name,
      protocol: entry.protocol,
      host: entry.host,
      port: String(entry.port),
      username: entry.username ?? '',
      password: entry.password ?? '',
    });
    setEditingId(entry.id);
    setFault(null);
  };

  const save = async () => {
    if (!draft.host || !draft.port) {
      setFault(messageText('environmentUi.proxyDepot.hostAndPortRequired'));
      return;
    }
    // 纯 JSON 载荷：空的可选键不进对象
    const record = {
      name: draft.name || `${draft.host}:${draft.port}`,
      protocol: draft.protocol,
      host: draft.host,
      port: Number(draft.port),
      ...(draft.username ? { username: draft.username } : {}),
      ...(draft.password ? { password: draft.password } : {}),
    };
    try {
      if (editingId === 'new') {
        await window.piskie.configuration.proxy.add({ ...record, enabled: true });
      } else if (editingId) {
        await window.piskie.configuration.proxy.update(editingId, record);
      }
      setEditingId(null);
      setFault(null);
      await refresh();
      onChanged();
    } catch (error) {
      setFault(error instanceof Error
        ? rawText(error.message)
        : messageText('environmentUi.proxyDepot.saveFailed'));
    }
  };

  const probe = async (proxyId: string) => {
    setProbing((prev) => new Set(prev).add(proxyId));
    try {
      const result = await window.piskie.configuration.proxy.test(proxyId);
      setProbes((prev) => ({ ...prev, [proxyId]: result }));
    } catch (error) {
      setProbes((prev) => ({
        ...prev,
        [proxyId]: { reachable: false, ...(error instanceof Error ? { error: error.message } : {}) },
      }));
    } finally {
      setProbing((prev) => {
        const next = new Set(prev);
        next.delete(proxyId);
        return next;
      });
    }
  };

  const remove = async (proxyId: string) => {
    try {
      await window.piskie.configuration.proxy.remove(proxyId);
      setFault(null);
      await refresh();
      onChanged();
    } catch (error) {
      setFault(error instanceof Error
        ? rawText(error.message)
        : messageText('environmentUi.proxyDepot.deleteFailed'));
    }
  };

  return (
    <SheetShell
      title={t('environmentUi.proxyDepot.title')}
      sub={t('environmentUi.proxyDepot.count', { count: proxies.length })}
      onClose={onClose}
      foot={
        <>
          <span style={{ marginInlineEnd: 'auto', alignSelf: 'center' }} className={styles.fieldWarn}>
            {fault
              ? resolvePresentationText(fault, (key, values) => t(key, values ?? {}))
              : null}
          </span>
          <ActPill tone="prime" onClick={beginCreate}>
            {t('environmentUi.proxyDepot.addProxy')}
          </ActPill>
        </>
      }
    >
      <p className={styles.sheetNote}>
        {t('environmentUi.proxyDepot.description')}
      </p>

      {proxies.map((proxy) => {
        const probeResult = probes[proxy.id];
        return (
          <div key={proxy.id} className={styles.depotRow}>
            <div className={styles.depotMain}>
              <div className={styles.depotName}>{proxy.name}</div>
              <div className={styles.depotAddr}>
                {proxy.protocol}://{proxy.host}:{proxy.port}
              </div>
              {probeResult && (
                <div className={`${styles.depotTest} ${probeResult.reachable ? styles.testOk : styles.testBad}`}>
                  {probeResult.reachable
                    ? `${probeResult.latencyMs ?? 0}ms${probeResult.externalIp ? ` · ${probeResult.externalIp}` : ''}`
                    : probeResult.error || t('environmentUi.proxyDepot.unavailable')}
                </div>
              )}
            </div>
            <span className={styles.depotOps}>
              <button
                type="button"
                className={styles.affixBtn}
                disabled={probing.has(proxy.id)}
                onClick={() => void probe(proxy.id)}
              >
                {probing.has(proxy.id)
                  ? t('environmentUi.proxyDepot.testing')
                  : t('environmentUi.proxyDepot.testAction')}
              </button>
              <button type="button" className={styles.affixBtn} onClick={() => beginEdit(proxy)}>
                {t('environmentUi.proxyDepot.editAction')}
              </button>
              <button
                type="button"
                className={`${styles.affixBtn} ${styles.affixHalt}`}
                onClick={() => {
                  if (armedId === proxy.id) {
                    setArmedId(null);
                    void remove(proxy.id);
                  } else {
                    setArmedId(proxy.id);
                  }
                }}
              >
                {armedId === proxy.id
                  ? t('environmentUi.proxyDepot.confirmDelete')
                  : t('environmentUi.proxyDepot.deleteAction')}
              </button>
            </span>
          </div>
        );
      })}

      {proxies.length === 0 && (
        <p className={styles.sheetNote}>{t('environmentUi.proxyDepot.empty')}</p>
      )}

      {editingId !== null && (
        <div style={{ display: 'grid', gap: 10, marginBlockStart: 16 }}>
          <div className={styles.formCap}>
            {editingId === 'new'
              ? t('environmentUi.proxyDepot.createSection')
              : t('environmentUi.proxyDepot.editSection')}
          </div>
          <input
            className={styles.textInput}
            placeholder={t('environmentUi.proxyDepot.namePlaceholder')}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <select
            className={styles.selectBox}
            value={draft.protocol}
            onChange={(event) => setDraft({ ...draft, protocol: event.target.value as ProxyProtocol })}
          >
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
            <option value="socks5">SOCKS5</option>
          </select>
          <div className={styles.hostPort}>
            <input
              className={styles.textInput}
              placeholder={t('environmentUi.proxyDepot.hostPlaceholder')}
              value={draft.host}
              onChange={(event) => setDraft({ ...draft, host: event.target.value })}
            />
            <input
              className={styles.textInput}
              placeholder={t('environmentUi.proxyDepot.portPlaceholder')}
              inputMode="numeric"
              value={draft.port}
              onChange={(event) => setDraft({ ...draft, port: event.target.value.replace(/\D/g, '') })}
            />
          </div>
          <div className={styles.rowSplit}>
            <input
              className={styles.textInput}
              placeholder={t('environmentUi.proxyDepot.usernamePlaceholder')}
              autoComplete="off"
              value={draft.username}
              onChange={(event) => setDraft({ ...draft, username: event.target.value })}
            />
            <input
              className={styles.textInput}
              placeholder={t('environmentUi.proxyDepot.passwordPlaceholder')}
              type="password"
              autoComplete="new-password"
              value={draft.password}
              onChange={(event) => setDraft({ ...draft, password: event.target.value })}
            />
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <ActPill tone="hush" onClick={() => setEditingId(null)}>
              {t('environmentUi.proxyDepot.cancelAction')}
            </ActPill>
            <ActPill tone="prime" onClick={() => void save()}>
              {editingId === 'new'
                ? t('environmentUi.proxyDepot.addAction')
                : t('environmentUi.proxyDepot.saveAction')}
            </ActPill>
          </div>
        </div>
      )}
    </SheetShell>
  );
};
