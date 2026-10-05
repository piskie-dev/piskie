import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConfigDescriptor } from '@shared/types/config';
import type { ModelUsageConfig, ProviderTokenBudget, ProviderTokenBudgetStatus } from '@shared/types/model-usage';
import { nextDefaultBudgetReset } from '@shared/provider-token-budget';
import { Dialog } from '../../console/chrome/Dialog';
import { applyConfigFieldChanges } from '../../config/config-transaction';
import deck from '../deck.module.css';
import styles from './providerTokenBudget.module.css';

function localInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  const part = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProviderTokenBudget({ providerId }: { readonly providerId: string }) {
  const { t, i18n } = useTranslation();
  const [config, setConfig] = useState<ModelUsageConfig>();
  const [descriptor, setDescriptor] = useState<ConfigDescriptor>();
  const [status, setStatus] = useState<ProviderTokenBudgetStatus | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [period, setPeriod] = useState<ProviderTokenBudget['period']>('weekly');
  const [limit, setLimit] = useState('');
  const [resetAt, setResetAt] = useState('');
  const budget = config?.providerBudgets?.[providerId];
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);

  const refresh = useCallback(async (isActive: () => boolean = () => true) => {
    const [document, details, current] = await Promise.all([
      window.piskie.configuration.read<ModelUsageConfig>('model-usage'),
      window.piskie.configuration.describe('model-usage'),
      window.piskie.observability.modelUsage.budget(providerId),
    ]);
    if (!isActive()) return;
    setConfig(document);
    setDescriptor(details);
    setStatus(current);
    setError('');
  }, [providerId]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => refresh(() => active))
      .catch((cause) => { if (active) setError(errorText(cause)); });
    const timer = setInterval(() => {
      void window.piskie.observability.modelUsage.budget(providerId)
        .then((current) => { if (active) setStatus(current); })
        .catch((cause) => { if (active) setError(errorText(cause)); });
    }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [providerId, refresh]);

  const openEditor = () => {
    const current = budget ?? { period: 'weekly' as const, limit: 0, resetAt: nextDefaultBudgetReset('weekly') };
    setPeriod(current.period);
    setLimit(current.limit ? String(current.limit) : '');
    setResetAt(localInputValue(current.resetAt));
    setError('');
    setEditing(true);
  };

  const persist = async (next: ProviderTokenBudget | null) => {
    if (!config || !descriptor) return;
    setSaving(true);
    setError('');
    try {
      const budgets = { ...config.providerBudgets };
      if (next) budgets[providerId] = next;
      else delete budgets[providerId];
      await applyConfigFieldChanges('model-usage', descriptor, config.revision, [
        { op: 'set', pathTemplate: '/providerBudgets', value: budgets },
      ]);
      await refresh();
      setEditing(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const tokens = Number(limit);
    const reset = new Date(resetAt).getTime();
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || !Number.isFinite(reset) || reset < 0) {
      setError(t('settings.provider.tokenBudget.invalid'));
      return;
    }
    void persist({ period, limit: tokens, resetAt: reset });
  };

  return <>
    <div className={deck.slab}>
      <div className={deck.slabCap}>
        {t('settings.provider.tokenBudget.title')}
        <span className={deck.capSpring} />
        <button type="button" className={`${deck.btn} ${deck.btnQuiet}`} onClick={openEditor} disabled={!config || !descriptor}
          aria-label={t(budget ? 'settings.provider.tokenBudget.edit' : 'settings.provider.tokenBudget.add')}>
          {budget ? <Pencil size={13} /> : <Plus size={13} />}
          {t(budget ? 'settings.provider.tokenBudget.edit' : 'settings.provider.tokenBudget.add')}
        </button>
      </div>
      {budget && status ? <>
        <div className={styles.metrics}>
          <div><span>{t('settings.provider.tokenBudget.remaining')}</span><strong>{status.remaining === undefined ? '—' : number(status.remaining)}</strong></div>
          <div><span>{t('settings.provider.tokenBudget.used')}</span><strong>{number(status.used)} / {number(budget.limit)}</strong></div>
        </div>
        <div className={styles.track} role="progressbar" aria-label={t('settings.provider.tokenBudget.used')}
          aria-valuemin={0} aria-valuemax={budget.limit} aria-valuenow={Math.min(budget.limit, status.used)}>
          <span style={{ width: `${Math.min(100, (status.used / budget.limit) * 100)}%` }} />
        </div>
        <div className={styles.foot}>
          <span>{t('settings.provider.tokenBudget.resets', { time: new Date(status.periodEnd).toLocaleString(locale) })}</span>
          {!status.complete && <span className={styles.incomplete}>{t('settings.provider.tokenBudget.incomplete')}</span>}
        </div>
      </> : <div className={styles.empty}>{budget ? t('settings.provider.tokenBudget.loading') : t('settings.provider.tokenBudget.unset')}</div>}
      {error && !editing && <div className={styles.error} role="alert">{error} <button type="button" onClick={() => void refresh().catch((cause) => setError(errorText(cause)))} aria-label={t('settings.provider.tokenBudget.retry')}><RefreshCw size={13} /></button></div>}
    </div>

    <Dialog open={editing} onClose={() => setEditing(false)} title={t('settings.provider.tokenBudget.title')} width={640} className={styles.dialog}>
      <div className={styles.editor}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('settings.provider.tokenBudget.period')}</span>
          <div className={styles.segment} role="group" aria-label={t('settings.provider.tokenBudget.period')}>
            {(['weekly', 'monthly'] as const).map((value) => <button key={value} type="button" aria-pressed={period === value} disabled={saving}
              onClick={() => { setPeriod(value); setResetAt(localInputValue(nextDefaultBudgetReset(value))); }}>
              {t(`settings.provider.tokenBudget.${value}`)}
            </button>)}
          </div>
        </div>
        <div className={styles.fields}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={`token-budget-limit-${providerId}`}>{t('settings.provider.tokenBudget.limit')}</label>
            <input id={`token-budget-limit-${providerId}`} type="number" min="1" step="1" value={limit} disabled={saving}
              onChange={(event) => setLimit(event.target.value)} />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={`token-budget-reset-${providerId}`}>{t('settings.provider.tokenBudget.resetAt')}</label>
            <input id={`token-budget-reset-${providerId}`} type="datetime-local" value={resetAt} disabled={saving}
              onChange={(event) => setResetAt(event.target.value)} />
          </div>
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          {budget && <button type="button" className={styles.remove} disabled={saving} onClick={() => void persist(null)}>{t('settings.provider.tokenBudget.remove')}</button>}
          <span />
          <button type="button" disabled={saving} onClick={() => setEditing(false)}>{t('common.cancel')}</button>
          <button type="button" className={styles.save} disabled={saving} onClick={save}>{t('common.save')}</button>
        </div>
      </div>
    </Dialog>
  </>;
}
