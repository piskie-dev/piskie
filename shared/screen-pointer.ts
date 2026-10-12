import { sameScreenPageInstance, type ScreenPageIdentity, type ScreenPointer } from './types/stream.js';

/** Positions live with their Page/Mouse instance; only click feedback has a freshness deadline. */
export const SCREEN_POINTER_POLICY = Object.freeze({
  pressFreshnessMs: 5_000,
  initialInset: 24,
  targetVisibleMs: 700,
  targetObservationMs: 80,
  activityVisibleMs: 900,
  feedbackFreshnessMs: 5_000,
  observationMaxMs: 3_000,
  scrollQuietMs: 80,
  scrollObservationMs: 500,
  motionMs: 120,
  manualMotionMs: 0,
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
  const order = observed.sourceOrder ?? observed.seq;
  const press = observed.action === 'down' && order > (current?.press?.order ?? current?.press?.seq ?? 0)
    ? { page: observed.page, seq: observed.seq, x: observed.x, y: observed.y,
        timestamp: observed.timestamp, clickCount: observed.clickCount, actor: observed.actor, order: observed.sourceOrder }
    : current?.press;
  if (current && order <= (current.sourceOrder ?? current.seq)) {
    return press === current.press ? current : { ...current, press };
  }
  return { ...observed, press,
    target: current?.target && current.target.seq > order ? current.target : undefined,
    positionTarget: current?.positionTarget && current.positionTarget.seq > order ? current.positionTarget : undefined,
    activity: current?.activity && current.activity.seq > order ? current.activity : undefined };
}

/** Derived separately for each visible viewport; source timestamps are unchanged. */
export interface PresentedScreenPointer extends ScreenPointer {
  /** Actual painted frame receiving the Page's position; source page/seq/time remain unchanged. */
  readonly framePage: ScreenPageIdentity;
  readonly visibleAt: number | null;
  readonly pressVisibleAt: number | null;
  readonly targetVisibleAt?: number | null;
  readonly activityVisibleAt?: number | null;
  /** Hidden feedback can retain a target position without replaying its highlight. */
  readonly targetSuppressed?: boolean;
  /** Last element position can remain on a later same-Page image without its old highlight. */
  readonly positionTarget?: ScreenPointer['target'];
}

export function screenPointerRevision(pointer: ScreenPointer): number {
  return pointer.revision ?? pointer.seq;
}

export function screenPressSequence(press: NonNullable<ScreenPointer['press']>): number {
  return press.order ?? press.seq;
}

export function screenPointerPosition(pointer: ScreenPointer): { readonly x: number; readonly y: number } {
  return pointer.target ?? pointer.positionTarget ?? pointer;
}
