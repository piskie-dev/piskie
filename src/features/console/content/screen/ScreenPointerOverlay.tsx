import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Activity, Focus, Hand, Keyboard, ListFilter, MessageSquare, MoveVertical, Navigation, TextCursorInput, Upload } from 'lucide-react';
import { sameScreenPage, type ScreenOperationKind } from '@shared/types/stream';
import { isRecentScreenPress, screenPointerPosition, screenPressSequence, SCREEN_POINTER_POLICY, type PresentedScreenPointer } from '@shared/screen-pointer';
import type { ScreenViewportFrame } from '@/domains/screen-feed/worker-protocol';
import { containGeometry, pageToLocal, type FrameSize } from './screenGeometry';
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
  const [area, setArea] = useState<VisibleArea | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let measured: FrameSize = { width: 0, height: 0 };
    const updateArea = () => setArea(visibleArea(element, measured));
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find(({ target }) => target === element);
      if (entry) {
        measured = { width: entry.contentRect.width, height: entry.contentRect.height };
        setSize(measured);
      }
      updateArea();
    });
    observer.observe(element);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${css.overflowX} ${css.overflowY}`)) observer.observe(parent);
    }
    window.addEventListener('scroll', updateArea, true);
    window.addEventListener('resize', updateArea);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', updateArea, true);
      window.removeEventListener('resize', updateArea);
    };
  }, []);

  const matching = pointer && frame && sameScreenPage(pointer.framePage, frame.page);
  const identity = pointer ? `${pointer.page.connectionId}:${pointer.page.pageId}` : '';
  return (
    <div ref={host} className={styles.layer} aria-hidden="true" data-screen-pointer-layer="true"
      style={{ ['--pointer-ripple-ms' as string]: `${SCREEN_POINTER_POLICY.rippleMs}ms` }}>
      {matching && <PointerEffects key={identity} pointer={pointer} frame={frame} size={size} area={area} onPresented={onPresented} />}
    </div>
  );
}

function usePointerMotion(target: PointerPosition, active: boolean, immediate = false): PointerPosition {
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
  const wasActive = useRef(false);
  useLayoutEffect(() => {
    motion.moveTo({ x: target.x, y: target.y }, reduced || !active || !wasActive.current || immediate);
    wasActive.current = active;
  }, [motion, target.x, target.y, reduced, active, immediate]);
  useLayoutEffect(() => () => motion.dispose(), [motion]);
  return position;
}

function PointerEffects({ pointer, frame, size, area, onPresented }: {
  readonly pointer: PresentedScreenPointer;
  readonly frame: ScreenViewportFrame;
  readonly size: FrameSize;
  readonly area: VisibleArea | null;
  readonly onPresented?: Presented;
}) {
  const artworkId = `pointer-mist-${useId()}`;
  const target = pointer.target && matchesTargetFrame(pointer.target, frame) ? pointer.target : undefined;
  const positionTarget = pointer.positionTarget ?? (pointer.target?.frameBefore !== undefined
    && ((frame.timestamp ?? 0) > pointer.target.frameBefore
      || (pointer.target.frameSeq !== undefined && frame.seq !== pointer.target.frameSeq))
    && matchesTargetViewport(pointer.target, frame) ? pointer.target : undefined);
  const desired = screenPointerPosition({ ...pointer, target, positionTarget });
  const projected = pageToLocal(desired, size, frame, frame.mapping);
  const inView = projected && (!area || (projected.x >= area.x && projected.y >= area.y
    && projected.x <= area.x + area.width && projected.y <= area.y + area.height));
  // Frame validation gates the highlight; the retained element still owns the arrow's visible point.
  const positionElement = target ?? positionTarget;
  const visibleTarget = !inView && positionElement && area ? visibleTargetPosition(positionElement.rect, size, frame, area) : null;
  const displayTarget = inView ? desired : visibleTarget ?? fallbackPosition(size, frame, area);
  const active = displayTarget !== null;
  const actor = target?.actor ?? positionTarget?.actor ?? pointer.actor;
  const position = usePointerMotion(displayTarget ?? desired, active, actor === 'manual' && SCREEN_POINTER_POLICY.manualMotionMs === 0);
  const point = active ? pageToLocal(position, size, frame, frame.mapping) : null;
  const [arrivedPress, setArrivedPress] = useState<number | null>(null);
  const press = pointer.press && sameScreenPage(pointer.press.page, frame.page) ? pointer.press : undefined;
  const arrived = samePointerPosition(position, displayTarget ?? desired);
  useLayoutEffect(() => {
    if (active) onPresented?.({ ...pointer, press: undefined, target: undefined, activity: undefined }, pointer.visibleAt ?? Date.now());
  }, [active, pointer, onPresented]);
  if (active && !target && inView && pointer.buttons !== 0 && arrived && press && arrivedPress !== screenPressSequence(press)) {
    setArrivedPress(screenPressSequence(press));
  }
  const pressed = !target && !!inView && pointer.buttons !== 0 && (arrived || (arrivedPress !== null && (!press || arrivedPress === screenPressSequence(press))));
  return <>
    {point && <svg className={styles.arrow} data-screen-pointer="true"
      data-pressed={pressed ? 'true' : 'false'} data-actor={actor ?? 'ai'}
      data-origin={inView || visibleTarget ? target || positionTarget ? 'element' : pointer.origin ?? 'mouse' : 'display-fallback'}
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
    {press && <PressRipple key={`press:${screenPressSequence(press)}`} pointer={{ ...pointer, target }} position={position}
      point={active && inView ? pageToLocal(press, size, frame, frame.mapping) : null} onPresented={onPresented} />}
    {target && !pointer.targetSuppressed && (inView || visibleTarget) && <TargetFeedback key={`target:${target.seq}`}
      pointer={{ ...pointer, target }} frame={frame} size={size} arrived={arrived} onPresented={onPresented} />}
    {pointer.activity && point && <ActivityFeedback key={`activity:${pointer.activity.seq}`} pointer={pointer}
      point={point} onPresented={onPresented} />}
    {actor === 'manual' && point && !pointer.activity && <span className={styles.activity}
      data-screen-pointer-actor="manual" style={{ left: point.x + 18, top: point.y + 22 }}><Hand size={12} /></span>}
  </>;
}

interface VisibleArea extends FrameSize { readonly x: number; readonly y: number }

function visibleArea(host: HTMLElement, size: FrameSize): VisibleArea {
  const box = host.getBoundingClientRect();
  if (!box.width || !box.height) return { x: 0, y: 0, ...size };
  let left = Math.max(box.left, 0), top = Math.max(box.top, 0);
  let right = Math.min(box.right, window.innerWidth), bottom = Math.min(box.bottom, window.innerHeight);
  for (let parent = host.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent), rect = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
    if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
  }
  return { x: (left - box.left) * size.width / box.width, y: (top - box.top) * size.height / box.height,
    width: Math.max(0, right - left) * size.width / box.width, height: Math.max(0, bottom - top) * size.height / box.height };
}

function visibleTargetPosition(rect: { x: number; y: number; width: number; height: number }, size: FrameSize,
  frame: ScreenViewportFrame, area: VisibleArea): PointerPosition | null {
  const start = pageToLocal(rect, size, frame, frame.mapping);
  const end = pageToLocal({ x: rect.x + rect.width, y: rect.y + rect.height }, size, frame, frame.mapping);
  const geometry = containGeometry(size, frame);
  if (!start || !end || !geometry) return null;
  const left = Math.max(start.x, area.x), right = Math.min(end.x, area.x + area.width);
  const top = Math.max(start.y, area.y), bottom = Math.min(end.y, area.y + area.height);
  if (right <= left || bottom <= top) return null;
  return {
    x: (((left + right) / 2 - geometry.offsetX) / geometry.scale - (frame.mapping?.offsetX ?? 0)) / (frame.mapping?.scale ?? 1),
    y: (((top + bottom) / 2 - geometry.offsetY) / geometry.scale - (frame.mapping?.offsetY ?? 0)) / (frame.mapping?.scale ?? 1),
  };
}

function fallbackPosition(size: FrameSize, frame: ScreenViewportFrame, area: VisibleArea | null): PointerPosition | null {
  const geometry = containGeometry(size, frame);
  if (!geometry || (area && (!area.width || !area.height))) return null;
  const x = Math.max(geometry.offsetX, area?.x ?? 0);
  const y = Math.max(geometry.offsetY, area?.y ?? 0);
  const right = Math.min(geometry.offsetX + frame.width * geometry.scale, area ? area.x + area.width : size.width);
  const bottom = Math.min(geometry.offsetY + frame.height * geometry.scale, area ? area.y + area.height : size.height);
  if (right <= x || bottom <= y) return null;
  const inset = SCREEN_POINTER_POLICY.initialInset;
  return {
    x: ((x + Math.min(inset * geometry.scale, (right - x) / 2) - geometry.offsetX) / geometry.scale - (frame.mapping?.offsetX ?? 0)) / (frame.mapping?.scale ?? 1),
    y: ((y + Math.min(inset * geometry.scale, (bottom - y) / 2) - geometry.offsetY) / geometry.scale - (frame.mapping?.offsetY ?? 0)) / (frame.mapping?.scale ?? 1),
  };
}

function matchesTargetViewport(target: NonNullable<PresentedScreenPointer['target']>, frame: ScreenViewportFrame): boolean {
  return sameScreenPage(target.page, frame.page)
    && (frame.scrollX === undefined || Math.abs(frame.scrollX - target.scrollX) < 1)
    && (frame.scrollY === undefined || Math.abs(frame.scrollY - target.scrollY) < 1);
}

function matchesTargetFrame(target: NonNullable<PresentedScreenPointer['target']>, frame: ScreenViewportFrame): boolean {
  return matchesTargetViewport(target, frame)
    && (target.frameAfter === undefined || (frame.timestamp !== undefined && frame.timestamp >= target.frameAfter))
    && (target.frameBefore === undefined || (frame.timestamp !== undefined && frame.timestamp <= target.frameBefore))
    && (target.frameSeq === undefined || frame.seq === target.frameSeq);
}

function useFeedbackClock(timestamp: number, visibleAt: number | null | undefined, eligible: boolean, duration: number) {
  const [at, setAt] = useState<number | null>(visibleAt ?? null);
  const [expired, setExpired] = useState(false);
  useLayoutEffect(() => {
    if (at !== null || !eligible) return;
    const frame = requestAnimationFrame(() => {
      if (Date.now() - timestamp <= SCREEN_POINTER_POLICY.feedbackFreshnessMs) setAt(Date.now());
    });
    return () => cancelAnimationFrame(frame);
  }, [at, eligible, timestamp]);
  useEffect(() => {
    if (at === null) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, at + duration - Date.now()));
    return () => window.clearTimeout(timer);
  }, [at, duration]);
  return { at, visible: eligible && at !== null && !expired };
}

function TargetFeedback({ pointer, frame, size, arrived, onPresented }: {
  readonly pointer: PresentedScreenPointer; readonly frame: ScreenViewportFrame; readonly size: FrameSize;
  readonly arrived: boolean; readonly onPresented?: Presented;
}) {
  const target = pointer.target!;
  const clock = useFeedbackClock(target.timestamp, pointer.targetVisibleAt, arrived, SCREEN_POINTER_POLICY.targetVisibleMs);
  const start = pageToLocal(target.rect, size, frame, frame.mapping);
  const end = pageToLocal({ x: target.rect.x + target.rect.width, y: target.rect.y + target.rect.height }, size, frame, frame.mapping);
  const visible = clock.visible && start && end;
  useLayoutEffect(() => {
    if (visible) onPresented?.({ ...pointer, press: undefined, activity: undefined }, clock.at!);
  }, [visible, pointer, onPresented, clock.at]);
  return visible ? <span className={styles.target} data-screen-pointer-target={target.kind} data-target-seq={target.seq}
    style={{ left: start.x, top: start.y, width: end.x - start.x, height: end.y - start.y }} /> : null;
}

const ACTIVITY_ICONS: Record<ScreenOperationKind, typeof Activity> = {
  input: TextCursorInput, select: ListFilter, upload: Upload, key: Keyboard, focus: Focus,
  scroll: MoveVertical, navigation: Navigation, operation: Activity, dialog: MessageSquare,
};
function ActivityFeedback({ pointer, point, onPresented }: {
  readonly pointer: PresentedScreenPointer; readonly point: PointerPosition; readonly onPresented?: Presented;
}) {
  const activity = pointer.activity!;
  const clock = useFeedbackClock(activity.timestamp, pointer.activityVisibleAt, true, SCREEN_POINTER_POLICY.activityVisibleMs);
  const visible = clock.visible || activity.pending;
  const Icon = activity.actor === 'manual' ? Hand : ACTIVITY_ICONS[activity.kind];
  useLayoutEffect(() => {
    if (visible) onPresented?.({ ...pointer, press: undefined, target: undefined }, clock.at ?? Date.now());
  }, [visible, pointer, onPresented, clock.at]);
  return visible ? <span className={styles.activity} data-screen-pointer-activity={activity.kind}
    data-screen-pointer-actor={activity.actor} data-pending={activity.pending ? 'true' : 'false'}
    data-scroll-x={activity.scroll?.x} data-scroll-y={activity.scroll?.y}
    style={{ left: point.x + 18, top: point.y + 22 }}><Icon size={12} /></span> : null;
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
    if (!samePointerPosition(screenPointerPosition(pointer), press)) setClock({ phase: 'skipped' });
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
