import { BookOpen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ComposerSkillOption } from '../../../../shared/types/skill';
import { SKILL_SCOPE_KEYS } from './skillScope';
import styles from './skillTags.module.css';

export function SkillTags({ skills, options, onRemove }: {
  readonly skills: readonly string[];
  readonly options?: readonly ComposerSkillOption[];
  readonly onRemove?: (name: string) => void;
}) {
  const { t } = useTranslation();
  if (skills.length === 0) return null;
  return (
    <div className={styles.tags} aria-label={t('sessionWorkbenchUi.composer.skills.selected')}>
      {skills.map((name) => {
        const option = options?.find((item) => item.name === name);
        const label = option ? `${name} · ${t(SKILL_SCOPE_KEYS[option.scope])}` : name;
        return (
          <span key={name} className={styles.tag} title={label}>
            <BookOpen size={12} aria-hidden />
            <span className={styles.name} aria-label={label}>{name}</span>
            {onRemove && (
              <button type="button" className={styles.remove} onClick={() => onRemove(name)}
                aria-label={t('sessionWorkbenchUi.composer.skills.remove', { name })}>
                <X size={11} aria-hidden />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
