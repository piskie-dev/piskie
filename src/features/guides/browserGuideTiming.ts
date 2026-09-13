import { interval } from './planTimeline';

// These segments share one scrolling form; the last segment also clicks Create.
const CREATION_SHOT_DURATIONS = [3200, 2000, 2600, 3200] as const;
export const BROWSER_CREATION_DURATION = CREATION_SHOT_DURATIONS.reduce<number>((sum, duration) => sum + duration, 0);
const BROWSER_START_DURATION = 6000;
const BROWSER_SIGNED_IN_DURATION = 2500;
export const BROWSER_BINDING_OPEN = {
  duration: 2600, moveStart: 1000, moveEnd: 1700, click: 1850, result: 2050,
  appearStart: 800, appearEnd: 1000,
} as const;
export const BROWSER_BINDING_PICK = {
  duration: 4050, moveStart: 100, moveEnd: 700, click: 850, result: 1050,
  appearStart: 0, appearEnd: 100,
} as const;
export const BROWSER_GUIDE_DURATION = BROWSER_CREATION_DURATION + BROWSER_START_DURATION + BROWSER_SIGNED_IN_DURATION
  + BROWSER_BINDING_OPEN.duration + BROWSER_BINDING_PICK.duration;

export function browserGuideFrame(clock: number): { phase: number; time: number; scrollProgress?: number } {
  let start = 0;
  for (const [phase, duration] of CREATION_SHOT_DURATIONS.entries()) {
    if (clock < start + duration) {
      const progress = interval(clock, 3200, 9000);
      return {
        phase, time: (clock - start) * 6000 / duration,
        scrollProgress: progress * progress * (3 - 2 * progress),
      };
    }
    start += duration;
  }
  const remaining = clock - BROWSER_CREATION_DURATION;
  if (remaining < BROWSER_START_DURATION) return { phase: 4, time: remaining };
  if (remaining < BROWSER_START_DURATION + BROWSER_SIGNED_IN_DURATION) {
    return { phase: 5, time: remaining - BROWSER_START_DURATION };
  }
  const binding = remaining - BROWSER_START_DURATION - BROWSER_SIGNED_IN_DURATION;
  return binding < BROWSER_BINDING_OPEN.duration
    ? { phase: 6, time: binding }
    : { phase: 7, time: binding - BROWSER_BINDING_OPEN.duration };
}
