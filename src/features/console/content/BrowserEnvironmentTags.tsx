import { Chrome, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useBrowserEnvironmentStore } from '@/store/browserEnvironmentStore';
import { browserEnvironmentNameOf } from '@/utils/browserEnvironmentPresentation';
import styles from './browserEnvironmentTags.module.css';

type BrowserEnvironmentTagsProps = {
  readonly environmentIds: readonly string[];
} & (
  | { readonly state: 'pending'; readonly onRemove?: (environmentId: string) => void; readonly standalone?: never }
  | { readonly state: 'joined'; readonly standalone?: boolean; readonly onRemove?: never }
);

export function BrowserEnvironmentTags({ environmentIds, state, standalone, onRemove }: BrowserEnvironmentTagsProps) {
  const { t } = useTranslation();
  const environments = useBrowserEnvironmentStore((store) => store.environments);
  if (environmentIds.length === 0) return null;

  const label = state === 'pending'
    ? t('sharedUi.browserBinding.session.pendingTags')
    : t(standalone
      ? 'sharedUi.browserBinding.session.joinedMessageOnly'
      : 'sharedUi.browserBinding.session.joinedMessage', { count: environmentIds.length });

  return (
    <div className={styles.tags} data-state={state} aria-label={label}>
      {state === 'joined' && <span className={styles.context}>{label}</span>}
      {environmentIds.map((id) => {
        const name = browserEnvironmentNameOf(environments, id);
        return (
          <span key={id} className={styles.tag} title={`${label} · ${name}`}>
            <Chrome size={12} aria-hidden />
            <span className={styles.tagName} aria-label={name}>{name}</span>
            {state === 'pending' && onRemove && (
              <button
                type="button"
                className={styles.tagRemove}
                onClick={() => onRemove(id)}
                aria-label={t('sharedUi.browserBinding.session.removePending', { name })}
              >
                <X size={11} aria-hidden />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
