import { useState } from 'react';
import { ArrowUpRight, Check, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ModelOptGroup } from '../../store/inferenceStore';
import { reasoningSelectionLabel } from '../../utils/reasoning-options';
import { Dialog } from '../console/chrome/Dialog';
import { modelDefaultReasoning } from './worker-preference-drafts';
import styles from './worker-model-dialog.module.css';

type ModelOption = ModelOptGroup['options'][number];

interface Props {
  open: boolean;
  groups: ModelOptGroup[];
  selected?: string;
  onSelect: (option: ModelOption) => void;
  onClose: () => void;
  onConfigureModels: () => void;
}

function formatTokens(value: number | undefined, locale: string): string {
  if (value === undefined) return '—';
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(value);
}

/** Read-only catalog metadata; selecting a model changes only the current type's draft. */
export function WorkerModelDialog(props: Props) {
  const { t } = useTranslation();
  return (
    <Dialog open={props.open} onClose={props.onClose} ariaLabel={t('agentManagement.chooseModel')}
      width={1000} className={styles.dialog} bodyClassName={styles.body}>
      {props.open && <WorkerModelPicker {...props} />}
    </Dialog>
  );
}

/** Shared catalog presentation without a native overlay or business requests. */
export function WorkerModelPicker(props: Omit<Props, 'open'> & { autoFocus?: boolean }) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<string | null>(null);
  const providers = props.groups.flatMap((group) => {
    const first = group.options[0];
    return first ? [{ ...group, id: first.target.providerId }] : [];
  });
  const activeProvider = providers.some((group) => group.id === provider) ? provider : null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = providers
    .filter((group) => activeProvider === null || group.id === activeProvider)
    .map((group) => ({
      ...group,
      options: group.options.filter((option) =>
        `${group.label} ${option.label} ${option.value}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      ),
    }))
    .filter((group) => group.options.length);
  const total = providers.reduce((count, group) => count + group.options.length, 0);
  const matchCount = matches.reduce((count, group) => count + group.options.length, 0);
  const close = () => {
    props.onClose();
    setQuery('');
    setProvider(null);
  };
  const capabilityLabels = {
    tools: t('agentManagement.modelPicker.tools'),
    vision: t('agentManagement.modelPicker.vision'),
    structuredOutput: t('agentManagement.modelPicker.structuredOutput'),
  } as const;

  return (
    <>
      <header className={styles.header}>
        <div>
          <h2>{t('agentManagement.chooseModel')}</h2>
          <p>{t('agentManagement.configuredOnly')}</p>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={close}
          aria-label={t('common.close')}
        >
          <X size={18} />
        </button>
      </header>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={16} />
          <input
            autoFocus={props.autoFocus ?? true}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('sessionWorkbenchUi.composer.searchModelOrProvider')}
            aria-label={t('sessionWorkbenchUi.composer.searchModel')}
          />
          {query && (
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setQuery('')}
              aria-label={t('agentManagement.modelPicker.clearSearch')}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <span className={styles.resultCount} role="status">
          {t('agentManagement.modelPicker.resultCount', { count: matchCount })}
        </span>
      </div>
      <div className={styles.content}>
        <nav className={styles.providers} aria-label={t('agentManagement.modelPicker.providers')}>
          <button
            type="button"
            aria-pressed={activeProvider === null}
            onClick={() => setProvider(null)}
          >
            <span>{t('agentManagement.modelPicker.allProviders')}</span>
            <small>{total}</small>
          </button>
          {providers.map((group) => (
            <button
              type="button"
              key={group.id}
              aria-pressed={activeProvider === group.id}
              onClick={() => setProvider(group.id)}
            >
              <span>{group.label}</span>
              <small>{group.options.length}</small>
            </button>
          ))}
        </nav>
        <div className={styles.results} key={`${activeProvider ?? ''}:${normalizedQuery}`}>
          {matches.map((group) => (
            <section className={styles.group} key={group.id} aria-label={group.label}>
              <h3>
                <span>{group.label}</span>
                <small>{group.options.length}</small>
              </h3>
              {group.options.map((option) => {
                const { definition } = option;
                const profile = definition.reasoning;
                const selected = props.selected === option.value;
                const reasoningLabel =
                  profile?.mode === 'none'
                    ? t('reasoning.none')
                    : reasoningSelectionLabel(modelDefaultReasoning(option), false, t);
                const capabilities = (
                  Object.keys(capabilityLabels) as Array<keyof typeof capabilityLabels>
                ).filter((key) => definition.capabilities[key] === true);
                return (
                  <button
                    type="button"
                    key={option.value}
                    className={styles.model}
                    aria-pressed={selected}
                    onClick={() => {
                      props.onSelect(option);
                      close();
                    }}
                  >
                    <span className={styles.modelHeading}>
                      <span className={styles.modelIdentity}>
                        <strong>{option.label}</strong>
                        <code>{option.target.modelId}</code>
                      </span>
                      {selected && (
                        <span className={styles.selected}>
                          <Check size={14} />
                          {t('agentManagement.modelPicker.selected')}
                        </span>
                      )}
                    </span>
                    <span className={styles.metrics}>
                      <span>
                        <small>{t('agentManagement.modelPicker.contextWindow')}</small>
                        <span
                          title={definition.limits.contextWindow?.toLocaleString(i18n.language)}
                        >
                          {formatTokens(definition.limits.contextWindow, i18n.language)}
                        </span>
                      </span>
                      <span>
                        <small>{t('agentManagement.modelPicker.maxOutput')}</small>
                        <span
                          title={definition.limits.maxOutputTokens?.toLocaleString(i18n.language)}
                        >
                          {formatTokens(definition.limits.maxOutputTokens, i18n.language)}
                        </span>
                      </span>
                      <span>
                        <small>{t('agentManagement.modelPicker.defaultReasoning')}</small>
                        <span>{reasoningLabel}</span>
                      </span>
                    </span>
                    {capabilities.length > 0 && (
                      <span className={styles.capabilities}>
                        {capabilities.map((key) => (
                          <span key={key}>{capabilityLabels[key]}</span>
                        ))}
                      </span>
                    )}
                  </button>
                );
              })}
            </section>
          ))}
          {matchCount === 0 && (
            <div className={styles.empty}>
              <Search size={24} />
              <p>{t(total ? 'agentManagement.noMatches' : 'agentManagement.noModels')}</p>
              {total > 0 && (
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => {
                    setQuery('');
                    setProvider(null);
                  }}
                >
                  {t('agentManagement.modelPicker.resetFilters')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <footer className={styles.footer}>
        <p>{t('agentManagement.modelPicker.selectionHint')}</p>
        <button
          type="button"
          className={styles.textButton}
          onClick={() => {
            close();
            props.onConfigureModels();
          }}
        >
          {t('agentManagement.configureModels')}
          <ArrowUpRight size={14} />
        </button>
      </footer>
    </>
  );
}
