import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, X } from 'lucide-react';

import type { MarketSource, MarketSourceKind } from '@shared/types/market';

import { Select, StatusBadge } from '../../components/shared';
import styles from './market.module.css';

interface SourceManagerDialogProps {
  open: boolean;
  sources: MarketSource[];
  busy: boolean;
  onClose: () => void;
  onAdd: (input: { name: string; kind: MarketSourceKind; url: string; ref?: string }) => Promise<boolean>;
  onRemove: (source: MarketSource) => void;
}

const sourceKindLabel = (kind: MarketSourceKind, translate: (key: string) => string): string => {
  if (kind === 'mcp-registry') return translate('marketUi.source.kindMcpRegistry');
  if (kind === 'openai-plugin-marketplace') return translate('marketUi.source.kindOpenAiPlugins');
  if (kind === 'anthropic-plugin-marketplace') return translate('marketUi.source.kindAnthropicPlugins');
  return translate('marketUi.source.kindSkillsRepository');
};

const SourceManagerDialog: React.FC<SourceManagerDialogProps> = ({
  open,
  sources,
  busy,
  onClose,
  onAdd,
  onRemove,
}) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<MarketSourceKind>('git-skills');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const sourceKindOptions: ReadonlyArray<{ value: MarketSourceKind; label: string }> = [
    { value: 'git-skills', label: t('marketUi.source.kindSkillsRepository') },
    { value: 'openai-plugin-marketplace', label: t('marketUi.source.kindOpenAiPlugins') },
    { value: 'anthropic-plugin-marketplace', label: t('marketUi.source.kindAnthropicPlugins') },
  ];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.setAttribute('closedby', 'any');
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !url.trim()) return;
    const added = await onAdd({
      name: name.trim(),
      kind,
      url: url.trim(),
      ref: ref.trim() || undefined,
    });
    if (added) {
      setName('');
      setUrl('');
      setRef('');
    }
  };

  return (
    <dialog ref={dialogRef} className={styles.dialog} onClose={onClose}>
      <div className={styles.dialogSheet}>
        <header className={styles.dialogHeader}>
          <div>
            <h2>{t('marketUi.source.managerTitle')}</h2>
            <p>{t('marketUi.source.managerDescription')}</p>
          </div>
          <button
            type="button"
            className={styles.dialogClose}
            onClick={onClose}
            aria-label={t('marketUi.source.closeManager')}
          >
            <X />
          </button>
        </header>

        <section className={styles.section}>
          <div className={styles.sectionTitle}>
            <span>{t('marketUi.source.currentSources')}</span>
            <small>{t('marketUi.source.sourceCount', { count: sources.length })}</small>
          </div>
          <div className={styles.memberList}>
            {sources.map((source) => (
              <div className={styles.sourceRow} key={source.id}>
                <div className={styles.sourceRowCopy}>
                  <div>
                    <strong>{source.name}</strong>
                    <StatusBadge variant={source.error ? 'error' : source.builtin ? 'primary' : 'accent'} bordered>
                      {source.error
                        ? t('marketUi.source.readFailed')
                        : source.builtin
                          ? t('marketUi.source.builtin')
                          : t('marketUi.source.custom')}
                    </StatusBadge>
                  </div>
                  <span>{sourceKindLabel(source.kind, t)} · {source.url}{source.ref ? ` @ ${source.ref}` : ''}</span>
                  {source.error && <small>{source.error}</small>}
                </div>
                {!source.builtin && (
                  <button
                    type="button"
                    className={styles.dangerIconButton}
                    onClick={() => onRemove(source)}
                    aria-label={t('marketUi.source.removeNamed', { name: source.name })}
                    title={t('marketUi.source.removeTitle')}
                  >
                    <Trash2 />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <form className={styles.sourceForm} onSubmit={submit}>
          <div className={styles.sectionTitle}>
            <span>{t('marketUi.source.addSource')}</span>
            <small>{t('marketUi.source.addSourceHint')}</small>
          </div>
          <div className={styles.sourceFormGrid}>
            <label>
              <span>{t('marketUi.source.displayName')}</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('marketUi.source.displayNamePlaceholder')}
                required
              />
            </label>
            <label>
              <span>{t('marketUi.source.sourceType')}</span>
              <Select
                variant="field"
                value={kind}
                options={sourceKindOptions}
                onChange={setKind}
                ariaLabel={t('marketUi.source.sourceTypeAria')}
              />
            </label>
            <label className={styles.sourceUrlField}>
              <span>{t('marketUi.source.addressOrPath')}</span>
              <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/org/repo.git" required />
            </label>
            <label>
              <span>{t('marketUi.source.refLabel')}</span>
              <input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="main" />
            </label>
          </div>
          <div className={styles.footerActions}>
            <button type="submit" className={styles.primaryButton} disabled={busy || !name.trim() || !url.trim()}>
              <Plus />
              {busy ? t('marketUi.source.adding') : t('marketUi.source.addAction')}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
};

export default SourceManagerDialog;
