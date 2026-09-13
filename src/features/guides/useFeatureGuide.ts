import { useCallback, useEffect, useState } from 'react';
import { useGuideStore, type GuideId } from './guideStore';
import { claimGuide, deferNextWelcome, releaseGuide } from './guideSession';

export function useFeatureGuide(id: GuideId) {
  const [open, setOpen] = useState(false);
  const [openedId, setOpenedId] = useState<GuideId | null>(null);
  const [token] = useState(() => Symbol('guide'));
  const status = useGuideStore((state) => state.statuses[id]);

  const present = useCallback((automatic: boolean) => {
    const state = useGuideStore.getState();
    if (automatic && state.statuses[id]) return false;
    if (!claimGuide(token, automatic)) return false;
    // Claim before rendering so simultaneous page candidates cannot both open.
    state.dismiss(id);
    if (automatic && id === 'model-setup') deferNextWelcome();
    setOpenedId(id);
    setOpen(true);
    return true;
  }, [id, token]);
  const show = useCallback(() => present(false), [present]);
  const showAutomatically = useCallback(() => present(true), [present]);
  const close = useCallback(() => {
    useGuideStore.getState().dismiss(openedId ?? id);
    setOpen(false);
    releaseGuide(token);
  }, [id, openedId, token]);
  const complete = useCallback(() => {
    useGuideStore.getState().understand(openedId ?? id);
    setOpen(false);
    releaseGuide(token);
  }, [id, openedId, token]);

  useEffect(() => () => releaseGuide(token), [token]);

  return { id: open ? openedId ?? id : id, open, unread: status !== 'understood', show, showAutomatically, close, complete };
}
