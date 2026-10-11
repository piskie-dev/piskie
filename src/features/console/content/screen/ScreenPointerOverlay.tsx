import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { sameScreenPage } from '@shared/types/stream';
import { isRecentScreenPress, SCREEN_POINTER_POLICY, type PresentedScreenPointer } from '@shared/screen-pointer';
import type { ScreenViewportFrame } from '@/domains/screen-feed/worker-protocol';
import { pageToLocal, type FrameSize } from './screenGeometry';
import { samePointerPosition, ScreenPointerMotion, type PointerPosition } from './screenPointerMotion';
import styles from './screenPointer.module.css';

type Presented = (pointer: PresentedScreenPointer, at: number) => void;

/** Shared by every viewport. A Page's real position is mapped through its painted frame. */
export function ScreenPointerOverlay({ pointer, frame, onPresented }: {
  readonly pointer: PresentedScreenPointer | null;
  readonly frame: ScreenViewportFrame | null;
  readonly onPresented?: Presented;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<FrameSize>({ width: 0, height: 0 });
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const matching = pointer && frame && sameScreenPage(pointer.framePage, frame.page);
  const identity = pointer ? `${pointer.page.connectionId}:${pointer.page.pageId}` : '';
  return (
    <div ref={host} className={styles.layer} aria-hidden="true" data-screen-pointer-layer="true"
      style={{ ['--pointer-ripple-ms' as string]: `${SCREEN_POINTER_POLICY.rippleMs}ms` }}>
      {matching && <PointerEffects key={identity} pointer={pointer} frame={frame} size={size} onPresented={onPresented} />}
    </div>
  );
}

function usePointerMotion(target: PointerPosition, active: boolean): PointerPosition {
  const [position, setPosition] = useState(target);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [motion] = useState(() => new ScreenPointerMotion({
    now: () => performance.now(),
    publish: setPosition,
    scheduleFrame: (callback) => {
      const id = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(id);
    },
  }));
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReduced(media.matches);
    media.addEventListener('change', changed);
    changed();
    return () => media.removeEventListener('change', changed);
  }, []);
  useLayoutEffect(() => {
    motion.moveTo({ x: target.x, y: target.y }, reduced || !active);
  }, [motion, target.x, target.y, reduced, active]);
  useLayoutEffect(() => () => motion.dispose(), [motion]);
  return position;
}

function PointerEffects({ pointer, frame, size, onPresented }: {
  readonly pointer: PresentedScreenPointer;
  readonly frame: ScreenViewportFrame;
  readonly size: FrameSize;
  readonly onPresented?: Presented;
}) {
  const artworkId = `pointer-mist-${useId()}`;
  const active = pageToLocal(pointer, size, frame, frame.mapping) !== null;
  const position = usePointerMotion(pointer, active);
  const point = active ? pageToLocal(position, size, frame, frame.mapping) : null;
  const [arrivedPress, setArrivedPress] = useState<number | null>(null);
  const press = pointer.press && sameScreenPage(pointer.press.page, frame.page) ? pointer.press : undefined;
  const arrived = samePointerPosition(position, pointer);
  useLayoutEffect(() => {
    if (active) onPresented?.({ ...pointer, press: undefined }, pointer.visibleAt ?? Date.now());
  }, [active, pointer, onPresented]);
  if (active && pointer.buttons !== 0 && arrived && press && arrivedPress !== press.seq) {
    setArrivedPress(press.seq);
  }
  const pressed = pointer.buttons !== 0 && (arrived || (arrivedPress !== null && (!press || arrivedPress === press.seq)));
  return <>
    {point && <svg className={styles.arrow} data-screen-pointer="true"
      data-pressed={pressed ? 'true' : 'false'}
      width="20" height="22" viewBox="2.15 1.65 20 22"
      style={{ left: point.x, top: point.y }}>
      <defs>
        <linearGradient id={`${artworkId}-rest`} x1="0" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#fff" />
          <stop offset="0.47" stopColor="#d6f3ff" />
          <stop offset="1" stopColor="#8fbfd4" />
        </linearGradient>
        <linearGradient id={`${artworkId}-press`} x1="0" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#e7faff" />
          <stop offset="1" stopColor="#69a7c3" />
        </linearGradient>
      </defs>
      <path className={styles.arrowEdge} d="M2.15 1.65L4.5 19.1Q4.58 19.62 4.94 19.17L8.85 13.92L16.7 13.5Q17.22 13.47 16.82 13.12Z" />
      <path className={styles.arrowBody} fill={`url(#${artworkId}-${pressed ? 'press' : 'rest'})`}
        d="M2.15 1.65L4.5 19.1Q4.58 19.62 4.94 19.17L8.85 13.92L16.7 13.5Q17.22 13.47 16.82 13.12Z" />
      <path className={styles.arrowFacet} d="M3.4 4.1L5.14 16.08L8.05 12.15Z" />
      <path className={styles.arrowFold} d="M4 5.15L8.85 13.92" />
    </svg>}
    {press && <PressRipple key={press.seq} pointer={pointer} position={position}
      point={active ? pageToLocal(press, size, frame, frame.mapping) : null} onPresented={onPresented} />}
  </>;
}

type PressClock = { readonly phase: 'waiting' | 'skipped' }
  | { readonly phase: 'showing'; readonly at: number; readonly elapsed: number };

/** A superseded, unpresented click is dropped rather than creating a historical motion stop. */
function PressRipple({ pointer, position, point, onPresented }: {
  readonly pointer: PresentedScreenPointer;
  readonly position: PointerPosition;
  readonly point: PointerPosition | null;
  readonly onPresented?: Presented;
}) {
  const [clock, setClock] = useState<PressClock>(() => {
    const at = pointer.pressVisibleAt;
    const elapsed = at === null ? 0 : Math.max(0, Date.now() - at);
    return at === null ? { phase: 'waiting' } : elapsed >= SCREEN_POINTER_POLICY.rippleMs
      ? { phase: 'skipped' } : { phase: 'showing', at, elapsed };
  });
  const [expired, setExpired] = useState(false);
  const press = pointer.press!;
  if (clock.phase === 'waiting') {
    if (!samePointerPosition(pointer, press)) setClock({ phase: 'skipped' });
    else if (point && samePointerPosition(position, press)) {
      setClock(() => {
        const at = Date.now();
        return isRecentScreenPress(press.timestamp, at)
          ? { phase: 'showing', at, elapsed: 0 } : { phase: 'skipped' };
      });
    }
  }
  const startedAt = clock.phase === 'showing' ? clock.at : null;
  const showing = point && startedAt !== null && !expired;
  useLayoutEffect(() => {
    if (showing) onPresented?.(pointer, startedAt!);
  }, [showing, pointer, startedAt, onPresented]);
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, startedAt + SCREEN_POINTER_POLICY.rippleMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [startedAt]);
  if (!showing || clock.phase !== 'showing') return null;
  return <span className={styles.ripple} data-screen-pointer-ripple="true"
    style={{ left: point.x, top: point.y, animationDelay: `${-clock.elapsed}ms` }} />;
}
