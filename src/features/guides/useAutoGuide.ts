import { useEffect, useRef } from 'react';
import { useFeatureGuide } from './useFeatureGuide';
import { useGuideStore, type GuideId } from './guideStore';
import { consumeWelcomeDeferral, hasGuideObstacle } from './guideSession';

export interface AutoGuideOptions {
  readonly id: GuideId;
  readonly ready: boolean;
  readonly eligible: boolean;
  readonly visitKey?: string;
  readonly blocked?: boolean;
}

export function useAutoGuide({ id, ready, eligible, visitKey = id, blocked = false }: AutoGuideOptions) {
  const guide = useFeatureGuide(id);
  const { showAutomatically } = guide;
  const visit = useRef({ cancelled: false, attempted: false, startedAt: 0 });

  useEffect(() => {
    const state = { cancelled: false, attempted: false, startedAt: Date.now() };
    visit.current = state;
    const cancel = () => { state.cancelled = true; };
    const events = ['pointerdown', 'keydown', 'input', 'paste', 'dragenter', 'visibilitychange'] as const;
    for (const event of events) document.addEventListener(event, cancel, true);
    window.addEventListener('blur', cancel);
    return () => {
      state.cancelled = true;
      for (const event of events) document.removeEventListener(event, cancel, true);
      window.removeEventListener('blur', cancel);
    };
  }, [visitKey]);

  useEffect(() => {
    const state = visit.current;
    if (state.attempted || !ready) return;
    if (!eligible) {
      state.attempted = true;
      // Existing business records mean this is not a first-use introduction.
      useGuideStore.getState().dismiss(id);
      return;
    }
    if (visitKey === 'welcome' && id === 'getting-started' && consumeWelcomeDeferral()) {
      state.attempted = true;
      return;
    }
    if (blocked || state.cancelled || hasGuideObstacle() || Date.now() - state.startedAt > 4000) {
      state.attempted = true;
      return;
    }
    const timer = window.setTimeout(() => {
      state.attempted = true;
      if (!state.cancelled) showAutomatically();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [blocked, eligible, showAutomatically, id, ready, visitKey]);

  return guide;
}
