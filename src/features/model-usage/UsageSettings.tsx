import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigDescriptor } from '../../../shared/types/config';
import type { ModelUsageConfig, UsageCleanupPreview, UsageStorageStatus } from '../../../shared/types/model-usage';
import { Dialog } from '../console/chrome/Dialog';
import { applyConfigFieldChanges } from '../config/config-transaction';
import styles from './model-usage.module.css';

const api = () => window.piskie.observability.modelUsage;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function UsageSettings({ open, close, changed, storage }: { open: boolean; close(): void; changed(): void; storage?: UsageStorageStatus }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<ModelUsageConfig>();
  const [descriptor, setDescriptor] = useState<ConfigDescriptor>();
  const [retention, setRetention] = useState<ModelUsageConfig['retentionDays']>(90);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ kind: 'clear' | 'shorten'; preview: UsageCleanupPreview; next?: ModelUsageConfig }>();
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void Promise.all([
      window.piskie.configuration.read<ModelUsageConfig>('model-usage'),
      window.piskie.configuration.describe('model-usage'),
    ]).then(([document, description]) => {
      if (disposed) return;
      setConfig(document); setDescriptor(description); setRetention(document.retentionDays);
    }).catch((cause) => { if (!disposed) setError(errorText(cause)); });
    return () => { disposed = true; };
  }, [open]);

  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };
  const commit = async (next: ModelUsageConfig) => {
    if (!config || !descriptor) return;
    await applyConfigFieldChanges('model-usage', descriptor, config.revision, [
      { op: 'set', pathTemplate: '/retentionDays', value: next.retentionDays },
    ]);
    setConfig(await window.piskie.configuration.read<ModelUsageConfig>('model-usage'));
    await api().cleanup(false, false);
    changed(); setNotice(t('modelUsage.saved'));
  };
  const save = () => perform(async () => {
    if (!config) return;
    const next = { ...config, retentionDays: retention };
    if ((next.retentionDays ?? Infinity) < (config.retentionDays ?? Infinity)) {
      setConfirmation({ kind: 'shorten', preview: await api().previewCleanup(next.retentionDays, false), next });
    } else await commit(next);
  });
  return <>
    <Dialog open={open} onClose={close} title={t('modelUsage.settings')} width={640}>
      <div className={styles.settings}>
        {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
        {!config && !error && <p>{t('modelUsage.loading')}</p>}
        {config && <>
          <section><h3>{t('modelUsage.retention')}</h3><p>{t('modelUsage.retentionHint')}</p>
            <div className={styles.retentionChoices}>{([30, 90, 180, 365, null] as const).map((days) => <button disabled={busy} key={String(days)} aria-pressed={retention === days} onClick={() => setRetention(days)}>{days === null ? t('modelUsage.forever') : t('modelUsage.days', { count: days })}</button>)}</div>
            <p>{t('modelUsage.cleanupPolicy')}</p><small>{t('modelUsage.lastCleanup', { time: storage?.lastCleanupAt ? new Date(storage.lastCleanupAt).toLocaleString() : t('modelUsage.notChecked') })}</small>
            <div className={styles.actions}><button disabled={busy} onClick={() => void perform(async () => { const result = await api().cleanup(false, false); changed(); setNotice(`${t('modelUsage.cleanupDone', { count: result.records })} ${t('modelUsage.skipped', { count: result.skippedFiles })}`); })}>{t('modelUsage.cleanupNow')}</button>
              <button className={styles.danger} disabled={busy} onClick={() => void perform(async () => setConfirmation({ kind: 'clear', preview: await api().previewCleanup(null, true) }))}>{t('modelUsage.clearAll')}</button></div>
          </section>
          <p className={styles.hint}>{t('modelUsage.logPolicy')}</p>
        </>}
        <div className={styles.actions}><button disabled={busy} onClick={close}>{t('modelUsage.close')}</button><button className={styles.primary} disabled={busy || !config} onClick={() => void save()}>{t('modelUsage.save')}</button></div>
      </div>
    </Dialog>
    <Dialog open={!!confirmation} onClose={() => setConfirmation(undefined)} title={t(confirmation?.kind === 'clear' ? 'modelUsage.confirmClear' : 'modelUsage.confirmShorten')} width={520}>
      {confirmation && <div className={styles.settings}>
        <p>{t('modelUsage.cleanupPreview', { files: confirmation.preview.files, count: confirmation.preview.records, size: `${(confirmation.preview.bytes / 1024).toFixed(1)} KiB` })}</p>
        {confirmation.preview.cutoff && <p>{t('modelUsage.cleanupBoundary', { cutoff: confirmation.preview.cutoff })}</p>}
        <p>{t('modelUsage.skipped', { count: confirmation.preview.skippedFiles })}</p><p>{t('modelUsage.cleanupScope')}</p>
        <div className={styles.actions}><button disabled={busy} onClick={() => setConfirmation(undefined)}>{t('modelUsage.cancel')}</button><button className={styles.danger} disabled={busy} onClick={() => void perform(async () => {
          if (confirmation.kind === 'clear') { const result = await api().cleanup(true, true); changed(); setNotice(t('modelUsage.cleanupDone', { count: result.records })); }
          else if (confirmation.next) await commit(confirmation.next);
          setConfirmation(undefined);
        })}>{t('modelUsage.confirm')}</button></div>
      </div>}
    </Dialog>
  </>;
}
