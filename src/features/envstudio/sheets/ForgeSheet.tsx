/**
 * EnvStudio · Forge（新建 / 编辑环境）
 *
 * 功能对齐旧「新建/编辑环境」弹窗：
 * 名称、用途（≤200 字，进 AI 上下文）、代理三态（直连/选已有/新建入池）、
 * 指纹（时区 ip/real/custom、地理 ip/custom/off、语言 ip/custom、UA 生成与跨系统告警、
 * 目标系统、CPU 核数）。控件全部为 Lumen 自绘，无 AntD。
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BrowserEnvironment, BrowserIdentityPolicy } from '@shared/types';
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

const PURPOSE_MAX = 200;

const FALLBACK_ZONES = [
  'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago',
  'America/Argentina/Buenos_Aires', 'America/Sao_Paulo', 'America/New_York',
  'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Madrid', 'Asia/Shanghai', 'Asia/Tokyo',
];

function zoneOptions(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
      'timeZone',
    );
    if (supported && supported.length > 0) return supported;
  } catch {
    /* 老运行时回退精选 */
  }
  return FALLBACK_ZONES;
}

const LOCALE_CODES = [
  'es-MX', 'es-AR', 'es-CL', 'es-CO', 'es-PE', 'es-ES', 'pt-BR', 'pt-PT',
  'en-US', 'en-GB', 'en-CA', 'zh-CN', 'zh-TW', 'zh-HK', 'ja-JP', 'ko-KR',
  'fr-FR', 'de-DE', 'it-IT', 'ru-RU', 'tr-TR', 'vi-VN', 'th-TH', 'id-ID', 'ar-SA',
];

type KernelOS = 'macos' | 'windows' | 'linux';

function hostOsSignature(): string {
  const probe = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Windows/i.test(probe)) return 'Windows NT 10.0; Win64; x64';
  if (/Macintosh|Mac OS X/i.test(probe)) return 'Macintosh; Intel Mac OS X 10_15_7';
  return 'X11; Linux x86_64';
}

function forgeUA(target: KernelOS | '', kernelBuild: string): string | null {
  const signature =
    target === 'windows'
      ? 'Windows NT 10.0; Win64; x64'
      : target === 'macos'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : target === 'linux'
          ? 'X11; Linux x86_64'
          : hostOsSignature();
  const major = /(\d{2,3})\./.exec(kernelBuild)?.[1];
  if (!major) return null;
  return `Mozilla/5.0 (${signature}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function uaOsMismatch(ua: string, target: KernelOS | ''): { claimed: string; expected: string } | null {
  if (!ua) return null;
  const expected =
    target === 'windows' ? 'Windows' : target === 'macos' ? 'Mac' : target === 'linux' ? 'Linux'
      : /Windows/.test(hostOsSignature()) ? 'Windows' : /Macintosh/.test(hostOsSignature()) ? 'Mac' : 'Linux';
  const claimed = /Windows/i.test(ua) ? 'Windows' : /Macintosh|Mac OS X/i.test(ua) ? 'Mac' : /Linux|X11/i.test(ua) ? 'Linux' : '';
  return claimed && claimed !== expected ? { claimed, expected } : null;
}

interface ForgeDraft {
  name: string;
  purpose: string;
  proxyMode: 'none' | 'existing' | 'new';
  proxyId: string;
  newProxy: { protocol: ProxyProtocol; host: string; port: string; username: string; password: string };
  tzMode: 'ip' | 'real' | 'custom';
  tzValue: string;
  geoMode: 'ip' | 'custom' | 'off';
  geoLat: string;
  geoLng: string;
  geoAcc: string;
  langMode: 'ip' | 'custom';
  langValue: string;
  userAgent: string;
  platform: KernelOS | '';
  cores: string;
}

function draftFrom(env: BrowserEnvironment | null): ForgeDraft {
  const policy = env?.identityPolicy;
  return {
    name: env?.name ?? '',
    purpose: env?.purpose ?? '',
    proxyMode: env?.proxyId ? 'existing' : 'none',
    proxyId: env?.proxyId ?? '',
    newProxy: { protocol: 'http', host: '', port: '', username: '', password: '' },
    tzMode: policy?.timezone.mode ?? 'ip',
    tzValue: policy?.timezone.mode === 'custom' ? policy.timezone.value : '',
    geoMode: policy?.geolocation.mode ?? 'ip',
    geoLat: policy?.geolocation.mode === 'custom' ? String(policy.geolocation.latitude) : '',
    geoLng: policy?.geolocation.mode === 'custom' ? String(policy.geolocation.longitude) : '',
    geoAcc: policy?.geolocation.mode === 'custom' && policy.geolocation.accuracy != null ? String(policy.geolocation.accuracy) : '1000',
    langMode: policy?.language.mode ?? 'ip',
    langValue: policy?.language.mode === 'custom' ? policy.language.value : '',
    userAgent: policy?.userAgent ?? '',
    platform: (policy?.platform as KernelOS | undefined) ?? '',
    cores: policy?.hardwareConcurrency != null ? String(policy.hardwareConcurrency) : '',
  };
}

const Seg: React.FC<{
  value: string;
  options: Array<[string, string]>;
  onChange(next: string): void;
}> = ({ value, options, onChange }) => (
  <span className={styles.seg} role="group">
    {options.map(([key, label]) => (
      <button
        type="button"
        key={key}
        className={`${styles.segBtn}${value === key ? ` ${styles.segOn}` : ''}`}
        aria-pressed={value === key}
        onClick={() => onChange(key)}
      >
        {label}
      </button>
    ))}
  </span>
);

interface ForgeSheetProps {
  env: BrowserEnvironment | null;
  proxies: ProxyProfile[];
  kernelBuild: string | null;
  onClose(): void;
  onSaved(): void;
}

export const ForgeSheet: React.FC<ForgeSheetProps> = ({ env, proxies, kernelBuild, onClose, onSaved }) => {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState<ForgeDraft>(() => draftFrom(env));
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<PresentationText | null>(null);
  const zones = useMemo(() => zoneOptions(), []);
  const languageNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([i18n.resolvedLanguage ?? i18n.language], { type: 'language' });
    } catch {
      return null;
    }
  }, [i18n.language, i18n.resolvedLanguage]);

  const patch = (part: Partial<ForgeDraft>) => setDraft((prev) => ({ ...prev, ...part }));
  const uaWarn = uaOsMismatch(draft.userAgent, draft.platform);
  const present = (value: PresentationText): string => (
    resolvePresentationText(value, (key, values) => t(key, values ?? {}))
  );

  const generateUA = () => {
    if (!kernelBuild) {
      setFault(messageText('environmentUi.forge.kernelUnavailable'));
      return;
    }
    const generated = forgeUA(draft.platform, kernelBuild);
    if (!generated) {
      setFault(messageText('environmentUi.forge.kernelVersionInvalid'));
      return;
    }
    patch({ userAgent: generated });
    setFault(null);
  };

  const copyUA = async () => {
    if (!draft.userAgent) return;
    try {
      await navigator.clipboard.writeText(draft.userAgent);
    } catch {
      setFault(messageText('environmentUi.forge.copyFailed'));
    }
  };

  const submit = async () => {
    if (!draft.name.trim()) {
      setFault(messageText('environmentUi.forge.nameRequired'));
      return;
    }
    if (draft.proxyMode === 'existing' && !draft.proxyId) {
      setFault(messageText('environmentUi.forge.proxyRequired'));
      return;
    }
    if (draft.tzMode === 'custom' && !draft.tzValue) {
      setFault(messageText('environmentUi.forge.timezoneRequired'));
      return;
    }
    if (draft.langMode === 'custom' && !draft.langValue) {
      setFault(messageText('environmentUi.forge.languageRequired'));
      return;
    }
    if (draft.geoMode === 'custom' && (!draft.geoLat || !draft.geoLng)) {
      setFault(messageText('environmentUi.forge.coordinatesRequired'));
      return;
    }
    if (draft.proxyMode === 'new' && (!draft.newProxy.host || !draft.newProxy.port)) {
      setFault(messageText('environmentUi.forge.newProxyRequired'));
      return;
    }

    setSaving(true);
    setFault(null);
    try {
      let boundProxy: string | undefined;
      if (draft.proxyMode === 'existing') {
        boundProxy = draft.proxyId;
      } else if (draft.proxyMode === 'new') {
        const raw = draft.newProxy;
        const created = await window.piskie.configuration.proxy.add({
          name: `${raw.host}:${raw.port}`,
          protocol: raw.protocol,
          host: raw.host,
          port: Number(raw.port),
          ...(raw.username ? { username: raw.username } : {}),
          ...(raw.password ? { password: raw.password } : {}),
          enabled: true,
        });
        boundProxy = created.id;
      }

      // 配置面要求纯 JSON 载荷：可选键一律条件展开，undefined 不进对象
      const policyDraft: BrowserIdentityPolicy = {
        ...(env?.identityPolicy.extra ? { extra: env.identityPolicy.extra } : {}),
        ...(draft.platform ? { platform: draft.platform } : {}),
        timezone: draft.tzMode === 'custom' ? { mode: 'custom', value: draft.tzValue } : { mode: draft.tzMode },
        geolocation:
          draft.geoMode === 'custom'
            ? {
                mode: 'custom' as const,
                latitude: Number(draft.geoLat),
                longitude: Number(draft.geoLng),
                ...(draft.geoAcc ? { accuracy: Number(draft.geoAcc) } : {}),
              }
            : { mode: draft.geoMode },
        language: draft.langMode === 'custom' ? { mode: 'custom', value: draft.langValue } : { mode: 'ip' },
        ...(draft.userAgent ? { userAgent: draft.userAgent } : {}),
        ...(draft.cores ? { hardwareConcurrency: Number(draft.cores) } : {}),
      };

      const submission = {
        name: draft.name.trim(),
        ...(draft.purpose.trim() ? { purpose: draft.purpose.trim() } : {}),
        ...(boundProxy ? { proxyId: boundProxy } : {}),
        identityPolicy: policyDraft,
      };

      if (env) {
        await window.piskie.pilot.environments.update(env.id, submission);
      } else {
        await window.piskie.pilot.environments.create(submission);
      }
      onSaved();
    } catch (error) {
      setFault(error instanceof Error
        ? rawText(error.message)
        : messageText('environmentUi.forge.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SheetShell
      title={env ? t('environmentUi.forge.editTitle') : t('environmentUi.forge.createTitle')}
      sub={env ? env.name : undefined}
      onClose={onClose}
      foot={
        <>
          <span style={{ marginInlineEnd: 'auto', alignSelf: 'center' }} className={styles.fieldWarn}>
            {fault ? present(fault) : null}
          </span>
          <ActPill tone="hush" onClick={onClose}>
            {t('environmentUi.forge.cancelAction')}
          </ActPill>
          <ActPill tone="prime" onClick={() => void submit()} disabled={saving}>
            {env ? t('environmentUi.forge.saveAction') : t('environmentUi.forge.createAction')}
          </ActPill>
        </>
      }
    >
      <div className={styles.formCap}>{t('environmentUi.forge.basicsSection')}</div>
      <div className={styles.field}>
        <label className={styles.fieldLabel}>
          <b>{t('environmentUi.forge.environmentName')}</b>
        </label>
        <input
          className={styles.textInput}
          value={draft.name}
          placeholder={t('environmentUi.forge.environmentNamePlaceholder')}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel}>
          <b>{t('environmentUi.forge.purpose')}</b>
          {' · '}{t('environmentUi.forge.purposeForAi')}
        </label>
        <textarea
          className={styles.textArea}
          rows={3}
          maxLength={PURPOSE_MAX}
          value={draft.purpose}
          placeholder={t('environmentUi.forge.purposePlaceholder')}
          onChange={(event) => patch({ purpose: event.target.value })}
        />
        <div className={styles.fieldHint}>
          {t('environmentUi.forge.purposeHint', { count: PURPOSE_MAX })}
        </div>
      </div>

      <div className={styles.formCap}>{t('environmentUi.forge.networkSection')}</div>
      <div className={styles.field}>
        <label className={styles.fieldLabel}>
          <b>{t('environmentUi.forge.proxy')}</b>
        </label>
        <Seg
          value={draft.proxyMode}
          options={[
            ['none', t('environmentUi.forge.proxyDirect')],
            ['existing', t('environmentUi.forge.proxyExisting')],
            ['new', t('environmentUi.forge.proxyNew')],
          ]}
          onChange={(next) => patch({ proxyMode: next as ForgeDraft['proxyMode'] })}
        />
        {draft.proxyMode === 'existing' && (
          <div style={{ marginBlockStart: 10 }}>
            <select
              className={styles.selectBox}
              value={draft.proxyId}
              onChange={(event) => patch({ proxyId: event.target.value })}
            >
              <option value="">{t('environmentUi.forge.selectProxy')}</option>
              {proxies.map((proxy) => (
                <option key={proxy.id} value={proxy.id}>
                  {proxy.name} · {proxy.protocol}
                </option>
              ))}
            </select>
          </div>
        )}
        {draft.proxyMode === 'new' && (
          <div style={{ marginBlockStart: 10, display: 'grid', gap: 10 }}>
            <select
              className={styles.selectBox}
              value={draft.newProxy.protocol}
              onChange={(event) =>
                patch({ newProxy: { ...draft.newProxy, protocol: event.target.value as ProxyProtocol } })
              }
            >
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
              <option value="socks5">SOCKS5</option>
            </select>
            <div className={styles.hostPort}>
              <input
                className={styles.textInput}
                placeholder={t('environmentUi.forge.hostPlaceholder')}
                value={draft.newProxy.host}
                onChange={(event) => patch({ newProxy: { ...draft.newProxy, host: event.target.value } })}
              />
              <input
                className={styles.textInput}
                placeholder={t('environmentUi.forge.portPlaceholder')}
                inputMode="numeric"
                value={draft.newProxy.port}
                onChange={(event) =>
                  patch({ newProxy: { ...draft.newProxy, port: event.target.value.replace(/\D/g, '') } })
                }
              />
            </div>
            <div className={styles.rowSplit}>
              <input
                className={styles.textInput}
                placeholder={t('environmentUi.forge.usernamePlaceholder')}
                autoComplete="off"
                value={draft.newProxy.username}
                onChange={(event) => patch({ newProxy: { ...draft.newProxy, username: event.target.value } })}
              />
              <input
                className={styles.textInput}
                placeholder={t('environmentUi.forge.passwordPlaceholder')}
                type="password"
                autoComplete="new-password"
                value={draft.newProxy.password}
                onChange={(event) => patch({ newProxy: { ...draft.newProxy, password: event.target.value } })}
              />
            </div>
            <div className={styles.fieldHint}>{t('environmentUi.forge.newProxyHint')}</div>
          </div>
        )}
      </div>

      <div className={styles.formCap}>{t('environmentUi.forge.identitySection')}</div>
      <div className={styles.field}>
        <label className={styles.fieldLabel}>
          <b>{t('environmentUi.forge.timezone')}</b>
        </label>
        <Seg
          value={draft.tzMode}
          options={[
            ['ip', t('environmentUi.forge.basedOnIp')],
            ['real', t('environmentUi.forge.useLocal')],
            ['custom', t('environmentUi.forge.custom')],
          ]}
          onChange={(next) => patch({ tzMode: next as ForgeDraft['tzMode'] })}
        />
        {draft.tzMode === 'custom' && (
          <div style={{ marginBlockStart: 10 }}>
            <input
              className={styles.textInput}
              list="st-zones"
              placeholder={t('environmentUi.forge.timezonePlaceholder')}
              value={draft.tzValue}
              onChange={(event) => patch({ tzValue: event.target.value })}
            />
            <datalist id="st-zones">
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </div>
        )}
        {draft.tzMode === 'real' && draft.proxyMode !== 'none' && (
          <div className={styles.fieldWarn}>
            {t('environmentUi.forge.localTimezoneProxyWarning')}
          </div>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>
          <b>{t('environmentUi.forge.geolocation')}</b>
        </label>
        <Seg
          value={draft.geoMode}
          options={[
            ['ip', t('environmentUi.forge.basedOnIp')],
            ['custom', t('environmentUi.forge.custom')],
            ['off', t('environmentUi.forge.deny')],
          ]}
          onChange={(next) => patch({ geoMode: next as ForgeDraft['geoMode'] })}
        />
        {draft.geoMode === 'off' && (
          <div className={styles.fieldHint}>
            {t('environmentUi.forge.geolocationDeniedHint')}
          </div>
        )}
        {draft.geoMode === 'custom' && (
          <div className={styles.rowTriple} style={{ marginBlockStart: 10 }}>
            <input
              className={styles.textInput}
              placeholder={t('environmentUi.forge.latitudePlaceholder')}
              value={draft.geoLat}
              onChange={(event) => patch({ geoLat: event.target.value })}
            />
            <input
              className={styles.textInput}
              placeholder={t('environmentUi.forge.longitudePlaceholder')}
              value={draft.geoLng}
              onChange={(event) => patch({ geoLng: event.target.value })}
            />
            <input
              className={styles.textInput}
              placeholder={t('environmentUi.forge.accuracyPlaceholder')}
              inputMode="numeric"
              value={draft.geoAcc}
              onChange={(event) => patch({ geoAcc: event.target.value.replace(/\D/g, '') })}
            />
          </div>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>
          <b>{t('environmentUi.forge.language')}</b>
        </label>
        <Seg
          value={draft.langMode}
          options={[
            ['ip', t('environmentUi.forge.basedOnIp')],
            ['custom', t('environmentUi.forge.custom')],
          ]}
          onChange={(next) => patch({ langMode: next as ForgeDraft['langMode'] })}
        />
        {draft.langMode === 'custom' && (
          <div style={{ marginBlockStart: 10 }}>
            <select
              className={styles.selectBox}
              value={draft.langValue}
              onChange={(event) => patch({ langValue: event.target.value })}
            >
              <option value="">{t('environmentUi.forge.selectLanguage')}</option>
              {LOCALE_CODES.map((code) => (
                <option key={code} value={code}>
                  {languageNames?.of(code) ?? code} · {code}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>
          <b>User-Agent</b>
        </label>
        <div className={styles.inputAffix}>
          <input
            className={styles.textInput}
            placeholder={t('environmentUi.forge.userAgentPlaceholder')}
            value={draft.userAgent}
            onChange={(event) => patch({ userAgent: event.target.value })}
          />
          <span className={styles.affixOps}>
            <button
              type="button"
              className={styles.affixBtn}
              title={t('environmentUi.forge.copyUa')}
              onClick={() => void copyUA()}
            >
              {t('environmentUi.forge.copyAction')}
            </button>
            <button
              type="button"
              className={styles.affixBtn}
              title={t('environmentUi.forge.generateUa')}
              onClick={generateUA}
            >
              {t('environmentUi.forge.generateAction')}
            </button>
          </span>
        </div>
        {uaWarn ? (
          <div className={styles.fieldWarn}>
            {t('environmentUi.forge.uaMismatch', uaWarn)}
          </div>
        ) : (
          <div className={styles.fieldHint}>
            {t('environmentUi.forge.uaHint')}
          </div>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>
          <b>{t('environmentUi.forge.platformAndCores')}</b>
        </label>
        <div className={styles.rowSplit}>
          <select
            className={styles.selectBox}
            value={draft.platform}
            onChange={(event) => patch({ platform: event.target.value as ForgeDraft['platform'] })}
          >
            <option value="">{t('environmentUi.forge.followHostPlatform')}</option>
            <option value="windows">Windows</option>
            <option value="macos">macOS</option>
            <option value="linux">Linux</option>
          </select>
          <select
            className={styles.selectBox}
            value={draft.cores}
            onChange={(event) => patch({ cores: event.target.value })}
          >
            <option value="">{t('environmentUi.forge.kernelDefault')}</option>
            {[2, 4, 6, 8, 10, 12, 16].map((n) => (
              <option key={n} value={String(n)}>
                {t('environmentUi.forge.coreCount', { count: n })}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.fieldHint}>
          {t('environmentUi.forge.advancedIdentityHint')}
        </div>
      </div>
    </SheetShell>
  );
};
