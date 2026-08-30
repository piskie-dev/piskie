/**
 * 代理表单弹窗（原生 dialog 重写）。
 *
 * 名称 / 协议(HTTP·HTTPS·SOCKS5)/ 主机 / 端口(1-65535)/
 * 用户名密码(可选)/ 启用。校验失败就地高亮 + 底栏原因。
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import type { ProxyProtocol } from '../../../../shared/types/proxy';
import type {
  ProxyCreateInput,
  ProxyProfile,
} from '../../../../shared/electron-contracts/configuration';
import { Toggle } from '../../../components/task-definition/controls';
import { useNativeDialog } from '../../../components/task-definition/useNativeDialog';
import styles from '../deck.module.css';

const PROTOCOLS: readonly ProxyProtocol[] = ['http', 'https', 'socks5'];
type ProxyFault = {
  readonly field: 'name' | 'host' | 'port';
  readonly messageKey:
    | 'settings.proxy.nameRequired'
    | 'settings.proxy.hostRequired'
    | 'settings.proxy.portInvalid';
};

export interface ProxyForgeProps {
  readonly editing?: ProxyProfile;
  readonly onClose: () => void;
  readonly onSave: (values: ProxyCreateInput) => Promise<void>;
}

export const ProxyForge: React.FC<ProxyForgeProps> = ({ editing, onClose, onSave }) => {
  const { t } = useTranslation();
  const dialogRef = useNativeDialog(true, onClose);
  const [name, setName] = useState(editing?.name ?? '');
  const [protocol, setProtocol] = useState<ProxyProtocol>(editing?.protocol ?? 'http');
  const [host, setHost] = useState(editing?.host ?? '');
  const [port, setPort] = useState(editing ? String(editing.port) : '');
  const [username, setUsername] = useState(editing?.username ?? '');
  const [password, setPassword] = useState(editing?.password ?? '');
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<ProxyFault | null>(null);

  const submit = async (): Promise<void> => {
    if (saving) return;
    if (!name.trim()) {
      setFault({ field: 'name', messageKey: 'settings.proxy.nameRequired' });
      return;
    }
    if (!host.trim()) {
      setFault({ field: 'host', messageKey: 'settings.proxy.hostRequired' });
      return;
    }
    const portValue = Number.parseInt(port, 10);
    if (!Number.isFinite(portValue) || portValue < 1 || portValue > 65535) {
      setFault({ field: 'port', messageKey: 'settings.proxy.portInvalid' });
      return;
    }
    setFault(null);
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        protocol,
        host: host.trim(),
        port: portValue,
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(password ? { password } : {}),
        enabled,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialogRef} className={styles.forgeShell} aria-label={t(editing ? 'settings.proxy.editTitle' : 'settings.proxy.addTitle')}>
      <div className={styles.forgeHead}>
        <span className={styles.forgeTitle}>{t(editing ? 'settings.proxy.editTitle' : 'settings.proxy.addTitle')}</span>
        <button type="button" className={styles.orbBtn} aria-label={t('common.close')} onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <div className={styles.forgeBody}>
        <section className={styles.forgeSect}>
          <div className={styles.sectCap}>{t('settings.proxy.targetSection')}</div>
          <div className={styles.duoGrid}>
            <div>
              <label className={styles.fieldTag}>{t('settings.proxy.name')}</label>
              <span className={styles.textIn} data-fault={fault?.field === 'name' ? 'true' : undefined}>
                <input
                  value={name}
                  placeholder={t('settings.proxy.nameExample')}
                  aria-label={t('settings.proxy.name')}
                  onChange={(event) => {
                    setName(event.target.value);
                    setFault(null);
                  }}
                />
              </span>
            </div>
            <div>
              <label className={styles.fieldTag}>{t('settings.proxy.protocol')}</label>
              <span className={styles.lever} role="group" aria-label={t('settings.proxy.protocol')}>
                {PROTOCOLS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    data-on={protocol === option}
                    onClick={() => setProtocol(option)}
                  >
                    {option.toUpperCase()}
                  </button>
                ))}
              </span>
            </div>
          </div>
          <div className={styles.duoGrid} style={{ gridTemplateColumns: '2fr 1fr' }}>
            <div>
              <label className={styles.fieldTag}>{t('settings.proxy.host')}</label>
              <span className={styles.textIn} data-fault={fault?.field === 'host' ? 'true' : undefined}>
                <input
                  value={host}
                  placeholder="proxy.example.com"
                  aria-label={t('settings.proxy.host')}
                  onChange={(event) => {
                    setHost(event.target.value);
                    setFault(null);
                  }}
                />
              </span>
            </div>
            <div>
              <label className={styles.fieldTag}>{t('settings.proxy.port')}</label>
              <span className={styles.textIn} data-fault={fault?.field === 'port' ? 'true' : undefined}>
                <input
                  className={styles.monoIn}
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  placeholder="1080"
                  aria-label={t('settings.proxy.port')}
                  onChange={(event) => {
                    setPort(event.target.value);
                    setFault(null);
                  }}
                />
              </span>
            </div>
          </div>
        </section>

        <section className={styles.forgeSect}>
          <div className={styles.sectCap}>{t('settings.proxy.credentialsSection')}</div>
          <div className={styles.duoGrid}>
            <div>
              <label className={styles.fieldTag}>{t('settings.proxy.username')}</label>
              <span className={styles.textIn}>
                <input value={username} aria-label={t('settings.proxy.username')} onChange={(event) => setUsername(event.target.value)} />
              </span>
            </div>
            <div>
              <label className={styles.fieldTag}>{t('settings.proxy.password')}</label>
              <span className={styles.textIn}>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  aria-label={t('settings.proxy.password')}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </span>
            </div>
          </div>
        </section>
      </div>

      <div className={styles.forgeFoot}>
        <Toggle on={enabled} ariaLabel={t('settings.proxy.enable')} onFlip={setEnabled} />
        <span style={{ fontSize: 12 }}>{t('settings.proxy.enabled')}</span>
        <span className={styles.footHint}>
          {fault ? <span className={styles.faultNote}>{t(fault.messageKey)}</span> : null}
        </span>
        <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} disabled={saving} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className={`${styles.btn} ${styles.btnPrime}`} disabled={saving} onClick={() => void submit()}>
          {saving ? t('settings.proxy.saving') : t('common.save')}
        </button>
      </div>
    </dialog>
  );
};
