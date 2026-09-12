import { Check, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FeatureGuideDialog } from './FeatureGuideDialog';
import { GUIDE_IDS, GUIDE_ICONS, type GuideId } from './catalog';
import { useFeatureGuide } from './useFeatureGuide';
import { useGuideAction } from './useGuideAction';
import styles from './guides.module.css';

export function GuideLibrary() {
  return <>{GUIDE_IDS.map((id) => <GuideRow key={id} id={id} />)}</>;
}

function GuideRow({ id }: { readonly id: GuideId }) {
  const { t } = useTranslation();
  const action = useGuideAction(id);
  const guide = useFeatureGuide(id);
  const Icon = GUIDE_ICONS[id];
  return (
    <>
      <button type="button" className={styles.libraryRow} onClick={guide.show} aria-haspopup="dialog" data-guide-id={id}>
        <Icon size={17} aria-hidden />
        <span className={styles.libraryCopy}><strong>{t(`guides.items.${id}.title`)}</strong><small>{t(`guides.items.${id}.category`)}</small></span>
        <span className={styles.libraryStatus}>{!guide.unread && <Check size={12} aria-hidden />}{t(guide.unread ? 'guides.unread' : 'guides.read')}</span>
        <ChevronRight size={14} aria-hidden />
      </button>
      <FeatureGuideDialog id={id} open={guide.open} onClose={guide.close} onComplete={guide.complete}
        {...action} />
    </>
  );
}
