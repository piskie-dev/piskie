import { sameScreenPageInstance, type ScreenPageIdentity, type ScreenPointer } from './types/stream.js';

/** Positions live with their Page/Mouse instance; only click feedback has a freshness deadline. */
export const SCREEN_POINTER_POLICY = Object.freeze({
  pressFreshnessMs: 5_000,
  motionMs: 120,
  motionEase: (progress: number): number => 1 - (1 - progress) ** 3,
  rippleMs: 360,
  navigationVisibleMs: 180,
  // Allows one short move plus visible click feedback, with bounded presentation waiting.
  navigationMaxDelayMs: 420,
});

export function isRecentScreenPress(timestamp: number, now: number): boolean {
  return now - timestamp <= SCREEN_POINTER_POLICY.pressFreshnessMs;
}

/** Fold successful acknowledgements at the observation owner, including concurrent clicks. */
export function reduceScreenPointer(previous: ScreenPointer | null, observed: ScreenPointer): ScreenPointer {
  const current = sameScreenPageInstance(previous?.page, observed.page) ? previous : null;
  const press = observed.action === 'down' && observed.seq > (current?.press?.seq ?? 0)
    ? { page: observed.page, seq: observed.seq, x: observed.x, y: observed.y,
        timestamp: observed.timestamp, clickCount: observed.clickCount }
    : current?.press;
  if (current && observed.seq <= current.seq) {
    return press === current.press ? current : { ...current, press };
  }
  return { ...observed, press };
}

/** Derived separately for each visible viewport; source timestamps are unchanged. */
export interface PresentedScreenPointer extends ScreenPointer {
  /** Actual painted frame receiving the Page's position; source page/seq/time remain unchanged. */
  readonly framePage: ScreenPageIdentity;
  readonly visibleAt: number | null;
  readonly pressVisibleAt: number | null;
}
