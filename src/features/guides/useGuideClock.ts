import { useEffect, useState } from 'react';
import { PLAN_GUIDE_DURATION, PLAN_GUIDE_STILL } from './planTimeline';

export function useGuideClock(duration = PLAN_GUIDE_DURATION, still = PLAN_GUIDE_STILL): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let clock = 0;
    let previous = performance.now();
    let painted = 0;
    const tick = (now: number) => {
      clock = (clock + now - previous) % duration;
      previous = now;
      if (now - painted >= 32) {
        setElapsed(clock);
        painted = now;
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      if (motion.matches) {
        setElapsed(still);
      } else if (!document.hidden) {
        previous = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };
    sync();
    motion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [duration, still]);

  return elapsed;
}
