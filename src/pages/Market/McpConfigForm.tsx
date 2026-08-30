import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';

import type { McpServerConfig, McpServerInfo } from '@shared/types/mcp';
import { useProxyStore } from '../../store/proxyStore';

import {
  addRegistryEnvironmentHint,
  buildMcpConfig,
  mcpConfigToDraft,
  mcpRegistrySearchQuery,
  registryEnvironmentHints,
  type McpConfigDraft,
  type McpKeyValueDraft,
  type McpRegistryEnvironmentHint,
} from './mcp-config-editor-model';
import styles from './mcp-config-editor.module.css';

interface McpConfigFormProps {
  server: McpServerInfo;
  saving: boolean;
  /** 目录里的服务名，与本机改过的 server 名不一定相同 */
  registryName?: string;
  onCancel: () => void;
  onSave: (config: McpServerConfig) => Promise<boolean>;
}

/** 名字像密钥的行默认遮住，避免值被截图或旁人看到 */
const SECRET_KEY_PATTERN = /key|token|secret|password|passwd|credential|auth/i;

interface KeyValueRowsProps {
  rows: McpKeyValueDraft[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  onChange: (rows: McpKeyValueDraft[]) => void;
}

const KeyValueRows: React.FC<KeyValueRowsProps> = ({ rows, keyPlaceholder, valuePlaceholder, onChange }) => {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());

  const toggleReveal = (index: number) => {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className={styles.pairEditor}>
      {rows.map((row, index) => {
        const secret = SECRET_KEY_PATTERN.test(row.key);
        const shown = revealed.has(index);
        return (
          <div className={styles.pairRow} key={index}>
            <input
              value={row.key}
              onChange={(event) => onChange(rows.map((item, position) =>
                position === index ? { ...item, key: event.target.value } : item))}
              placeholder={keyPlaceholder}
              spellCheck={false}
            />
            <div className={styles.pairValueCell}>
              <input
                type={secret && !shown ? 'password' : 'text'}
                value={row.value}
                onChange={(event) => onChange(rows.map((item, position) =>
                  position === index ? { ...item, value: event.target.value } : item))}
                placeholder={valuePlaceholder}
                autoComplete={secret ? 'new-password' : 'off'}
                spellCheck={false}
              />
              {secret && (
                <button
                  type="button"
                  className={styles.pairReveal}
                  onClick={() => toggleReveal(index)}
                  aria-label={shown
                    ? t('marketUi.mcpConfig.hideSecret')
                    : t('marketUi.mcpConfig.showSecret')}
                >
                  {shown ? <EyeOff /> : <Eye />}
                </button>
              )}
            </div>
            <button
              type="button"
              className={styles.pairRemove}
              onClick={() => {
                onChange(rows.filter((_, position) => position !== index));
                setRevealed((current) => new Set([...current].filter((position) => position !== index)));
              }}
              aria-label={t('marketUi.mcpConfig.removeRow')}
            >
              <Trash2 />
            </button>
          </div>
        );
      })}
      <button type="button" className={styles.addPairButton} onClick={() => onChange([...rows, { key: '', value: '' }])}>
        <Plus />{t('marketUi.mcpConfig.addRow')}
      </button>
    </div>
  );
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className={styles.field}>
    <span>{label}{hint && <small>{hint}</small>}</span>
    {children}
  </label>
);

const McpConfigForm: React.FC<McpConfigFormProps> = ({ server, saving, registryName, onCancel, onSave }) => {
  const { t } = useTranslation();
  const proxyConfig = useProxyStore((state) => state.config);
  const fetchProxyConfig = useProxyStore((state) => state.fetchConfig);
  const [draft, setDraft] = useState<McpConfigDraft>(() => mcpConfigToDraft(server.config));
  const [validationVisible, setValidationVisible] = useState(false);
  const [hints, setHints] = useState<McpRegistryEnvironmentHint[]>([]);

  useEffect(() => {
    let cancelled = false;
    const query = mcpRegistrySearchQuery(server.name, registryName);
    void window.piskie.capabilities.mcp.search(query)
      .then((response) => {
        if (cancelled) return;
        setHints(registryEnvironmentHints(response, server.name, server.config));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [registryName, server]);

  useEffect(() => {
    if (!proxyConfig) void fetchProxyConfig();
  }, [fetchProxyConfig, proxyConfig]);

  const missingHints = useMemo(
    () => hints.filter((hint) => !draft.env.some((row) => row.key.trim() === hint.name)),
    [draft.env, hints],
  );

  const updateDraft = <Key extends keyof McpConfigDraft>(key: Key, value: McpConfigDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (validationVisible) setValidationVisible(false);
  };

  const validation = buildMcpConfig(draft, server.config, {
    commandRequired: t('marketUi.mcpConfig.commandRequired'),
    addressRequired: t('marketUi.mcpConfig.addressRequired'),
    addressProtocol: t('marketUi.mcpConfig.addressProtocol'),
    addressInvalid: t('marketUi.mcpConfig.addressInvalid'),
    environmentVariables: t('marketUi.mcpConfig.environmentVariables'),
    requestHeaders: t('marketUi.mcpConfig.requestHeaders'),
    missingRowName: (label, row) => t('marketUi.mcpConfig.missingRowName', { label, row }),
    duplicateRowName: (label, name) => t('marketUi.mcpConfig.duplicateRowName', { label, name }),
  });

  const save = async () => {
    if (!validation.success) {
      setValidationVisible(true);
      return;
    }
    if (await onSave(validation.config)) setValidationVisible(false);
  };

  const isStdio = draft.transport === 'stdio';

  return (
    <div className={styles.form}>
      <div
        className={styles.transportChoice}
        role="radiogroup"
        aria-label={t('marketUi.mcpConfig.transportAria')}
      >
        <button
          type="button"
          className={isStdio ? styles.transportActive : ''}
          aria-checked={isStdio}
          role="radio"
          onClick={() => updateDraft('transport', 'stdio')}
        >
          {t('marketUi.mcpConfig.localCommand')}
        </button>
        <button
          type="button"
          className={!isStdio ? styles.transportActive : ''}
          aria-checked={!isStdio}
          role="radio"
          onClick={() => updateDraft('transport', 'streamable_http')}
        >
          {t('marketUi.mcpConfig.remoteAddress')}
        </button>
      </div>

      {isStdio ? (
        <>
          <Field label={t('marketUi.mcpConfig.command')}>
            <input
              value={draft.command}
              onChange={(event) => updateDraft('command', event.target.value)}
              placeholder="npx"
              spellCheck={false}
            />
          </Field>
          <Field
            label={t('marketUi.mcpConfig.arguments')}
            hint={t('marketUi.mcpConfig.onePerLine')}
          >
            <textarea
              value={draft.argsText}
              onChange={(event) => updateDraft('argsText', event.target.value)}
              placeholder={'-y\n@upstash/context7-mcp'}
              spellCheck={false}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label={t('marketUi.mcpConfig.address')}>
            <input
              value={draft.url}
              onChange={(event) => updateDraft('url', event.target.value)}
              placeholder="https://example.com/mcp"
              spellCheck={false}
            />
          </Field>
          <Field
            label={t('marketUi.mcpConfig.outboundProxy')}
            hint={t('marketUi.mcpConfig.globalProxyPoolHint')}
          >
            <select
              value={draft.proxyId || '__direct__'}
              onChange={(event) => updateDraft(
                'proxyId',
                event.target.value === '__direct__' ? '' : event.target.value,
              )}
            >
              <option value="__direct__">{t('marketUi.mcpConfig.directConnection')}</option>
              {(proxyConfig?.proxies ?? [])
                .filter((proxy) => proxy.enabled || proxy.id === draft.proxyId)
                .map((proxy) => (
                  <option value={proxy.id} key={proxy.id}>
                    {proxy.name}
                    {proxy.enabled ? '' : ` (${t('marketUi.mcpConfig.proxyDisabled')})`}
                  </option>
                ))}
            </select>
          </Field>
        </>
      )}

      <div className={styles.field}>
        <span>
          {isStdio
            ? t('marketUi.mcpConfig.environmentVariables')
            : t('marketUi.mcpConfig.requestHeaders')}
          {isStdio && missingHints.map((hint) => (
            <button
              type="button"
              className={styles.hintChip}
              key={hint.name}
              title={hint.description}
              onClick={() => updateDraft('env', addRegistryEnvironmentHint(draft.env, hint))}
            >
              <Plus />{hint.name}
            </button>
          ))}
        </span>
        {isStdio ? (
          <KeyValueRows
            rows={draft.env}
            keyPlaceholder="CONTEXT7_API_KEY"
            valuePlaceholder={t('marketUi.mcpConfig.valuePlaceholder')}
            onChange={(rows) => updateDraft('env', rows)}
          />
        ) : (
          <KeyValueRows
            rows={draft.httpHeaders}
            keyPlaceholder="Authorization"
            valuePlaceholder={t('marketUi.mcpConfig.valuePlaceholder')}
            onChange={(rows) => updateDraft('httpHeaders', rows)}
          />
        )}
        {(isStdio ? draft.env : draft.httpHeaders).length > 0 && (
          <small className={styles.plaintextNote}>{t('marketUi.mcpConfig.plaintextNotice')}</small>
        )}
      </div>

      {validationVisible && !validation.success && (
        <p className={styles.formError}>
          {validation.errors.join(t('marketUi.mcpConfig.errorSeparator'))}
        </p>
      )}

      <div className={styles.formActions}>
        <button type="button" className={styles.formCancel} onClick={onCancel} disabled={saving}>
          {t('marketUi.mcpConfig.cancelAction')}
        </button>
        <button type="button" className={styles.formSave} onClick={() => void save()} disabled={saving}>
          {saving ? t('marketUi.mcpConfig.saving') : t('marketUi.mcpConfig.saveAction')}
        </button>
      </div>
    </div>
  );
};

export default McpConfigForm;
