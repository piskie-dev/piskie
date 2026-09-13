import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ChevronRight, MousePointer2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GuideId } from './catalog';
import { interval } from './planTimeline';
import { paintGuideClick } from './guideClick';
import styles from './guides.module.css';
import scene from './businessScenes.module.css';
import logo from '/logo-64.png';

export interface BusinessFrameProps {
  readonly phase: number;
  readonly time: number;
}

interface CursorTiming {
  readonly moveStart: number;
  readonly moveEnd: number;
  readonly click: number;
  readonly appearStart: number;
  readonly appearEnd: number;
}
const DEFAULT_CURSOR_TIMING: CursorTiming = {
  moveStart: 2500, moveEnd: 3600, click: 4000, appearStart: 2450, appearEnd: 2700,
};

/** Scenes contain read-only business markup, never the pages' stores or IPC actions. */
export function SceneStage({
  id,
  phase,
  time,
  children,
  cursorTarget,
  continuousCursor = false,
  fadeIn = true,
  cursorTiming = DEFAULT_CURSOR_TIMING,
}: BusinessFrameProps & {
  readonly id: GuideId;
  readonly children: ReactNode;
  readonly cursorTarget?: string;
  readonly continuousCursor?: boolean;
  readonly fadeIn?: boolean;
  readonly cursorTiming?: CursorTiming;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const motion = useRef<{
    id: GuideId;
    phase: number;
    from: { x: number; y: number };
    position: { x: number; y: number };
  } | null>(null);
  useLayoutEffect(() => {
    const stage = root.current;
    const pointer = cursor.current;
    if (!stage || !pointer) return;
    stage.setAttribute('inert', '');
    const draw = () => {
      const bounds = stage.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const previous = motion.current;
      // Retain the last pointer position across shots; only a new playback starts at the edge.
      if (!previous || previous.id !== id || previous.phase !== phase) {
        const from = previous && previous.id === id && phase > previous.phase
          ? previous.position
          : { x: 0.84, y: 0.85 };
        motion.current = { id, phase, from, position: from };
      }
      const current = motion.current!;
      const anchor = stage.querySelector(cursorTarget ?? '[data-demo-target="true"]');
      const target = anchor?.querySelector('button') ?? anchor;
      if (!target) {
        if (continuousCursor) {
          pointer.style.transform = `translate(${current.position.x * bounds.width - 4}px, ${current.position.y * bounds.height - 4}px)`;
          // Closing a picker removes the clicked element, but the pointer stays in place.
          pointer.style.opacity = '1';
          paintGuideClick(pointer, time, [cursorTiming.click]);
        } else {
          pointer.style.opacity = '0';
        }
        return;
      }
      const rect = target.getBoundingClientRect();
      const travel = interval(time, cursorTiming.moveStart, cursorTiming.moveEnd);
      const eased = travel * travel * (3 - 2 * travel);
      const start = continuousCursor ? current.from : { x: 0.84, y: 0.85 };
      const x =
        bounds.width * start.x +
        (rect.left - bounds.left + rect.width / 2 - bounds.width * start.x) * eased;
      const y =
        bounds.height * start.y +
        (rect.top - bounds.top + rect.height / 2 - bounds.height * start.y) * eased;
      current.position = { x: x / bounds.width, y: y / bounds.height };
      pointer.style.transform = `translate(${x - 4}px, ${y - 4}px)`;
      pointer.style.opacity = String(continuousCursor
        ? phase === 0 ? interval(time, cursorTiming.appearStart, cursorTiming.appearEnd) : 1
        : interval(time, cursorTiming.appearStart, cursorTiming.appearEnd) * (1 - interval(time, 4800, 5200)));
      paintGuideClick(pointer, time, [cursorTiming.click]);
    };
    draw();
    const resize = new ResizeObserver(draw);
    resize.observe(stage);
    return () => resize.disconnect();
  }, [id, phase, time, t, cursorTarget, continuousCursor, cursorTiming]);
  return (
    <div
      ref={root}
      className={`${styles.stage} ${scene.stage}`}
      aria-hidden="true"
      data-guide-scene={`${id}-${phase}`}
    >
      <div className={styles.stageTop}>
        <img src={logo} alt="" className={`${styles.mark} app-logo-adaptive`} />
        <ChevronRight size={11} />
        <span>{t(`guides.items.${id}.category`)}</span>
      </div>
      <div className={scene.shot} style={{ opacity: !fadeIn || (continuousCursor && phase > 0) ? 1 : interval(time, 0, 180) }}>
        {children}
      </div>
      <div ref={cursor} className={styles.cursor}>
        <i />
        <MousePointer2 size={28} />
      </div>
    </div>
  );
}
