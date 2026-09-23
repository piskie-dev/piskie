import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UsageFacet } from '../../../shared/types/model-usage';
import { Dialog } from '../console/chrome/Dialog';
import styles from './model-usage.module.css';

export function UsagePicker({ label, value, items, onChange }: {
  label: string; value?: string; items: UsageFacet[]; onChange(value: string | undefined): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(100);
  const selected = items.find((item) => item.id === value);
  const displayValue = value === undefined ? t('modelUsage.all') : selected?.label || value || t('modelUsage.none');
  const filtered = items.filter((item) => `${item.label} ${item.id}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <>
    <div className={styles.pickerField}>
      <span className={styles.fieldLabel}>{label}</span>
      <button className={styles.filterButton} data-active={value !== undefined} onClick={() => { setSearch(''); setLimit(100); setOpen(true); }} aria-label={label} aria-haspopup="dialog" aria-expanded={open} title={displayValue}>
        <b>{displayValue}</b><ChevronDown size={14} aria-hidden="true" />
      </button>
    </div>
    <Dialog open={open} onClose={() => setOpen(false)} title={label} width={520} bodyClassName={styles.pickerDialog}>
      <input className={styles.search} autoFocus value={search} aria-label={t('modelUsage.search')} placeholder={t('modelUsage.search')} onChange={(e) => { setSearch(e.target.value); setLimit(100); }} />
      <div className={styles.pickerList}>
        <button aria-pressed={value === undefined} onClick={() => { onChange(undefined); setOpen(false); }}>{t('modelUsage.all')}</button>
        {filtered.slice(0, limit).map((item) => <button key={item.id} aria-pressed={value === item.id} onClick={() => { onChange(item.id); setOpen(false); }}>
          <strong>{item.label || t('modelUsage.none')}</strong><small>{item.id}</small>
        </button>)}
        {!filtered.length && <p>{t('modelUsage.noMatch')}</p>}
        {filtered.length > limit && <button onClick={() => setLimit(limit + 100)}>{t('modelUsage.showMore')}</button>}
      </div>
    </Dialog>
  </>;
}
