import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Eye, Maximize2, Minus, PanelRightClose, Scan, ZoomIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BrowserScreenView } from '../../content/ScreenView';
import { showBrowserWindow } from '../../content/screen/showBrowserWindow';
import { useWorkerActivity } from '../../data/useWorkerActivity';
import type { BrowserMonitorController } from './useBrowserMonitor';
import { constrainMonitorRect, type MonitorArea, type MonitorRect, type MonitorTask, type MonitorWindow } from './monitorState';
import styles from './browserMonitor.module.css';

interface MonitorPanelProps {
  readonly agentId: string;
  readonly tasks: readonly MonitorTask[];
  readonly hidden: boolean;
  readonly windows: readonly MonitorWindow[];
  readonly onOpen: (key: string) => void;
  readonly trackFrame: BrowserMonitorController['trackFrame'];
}

export const BrowserMonitorPanel = memo(function BrowserMonitorPanel(props: MonitorPanelProps) {
  return <div className={styles.collection} data-browser-monitor="true">
    {props.tasks.map((task) => <MonitorCard key={task.key} {...props} task={task} />)}
  </div>;
});

function useMonitorFrame(key: string, trackFrame: BrowserMonitorController['trackFrame']) {
  const lifetime = useMemo(() => ({ frame: null as ReturnType<BrowserMonitorController['trackFrame']> | null }), [key, trackFrame]);
  useLayoutEffect(() => {
    const frame = trackFrame(key);
    lifetime.frame = frame;
    return () => { lifetime.frame = null; frame.release(); };
  }, [key, lifetime, trackFrame]);
  return useCallback((available: boolean) => lifetime.frame?.setAvailable(available), [lifetime]);
}

function MonitorCard({ agentId, task, hidden, windows, onOpen, trackFrame }: MonitorPanelProps & { task: MonitorTask }) {
  const { t } = useTranslation();
  const activity = useWorkerActivity(agentId, task.workerId);
  const [ratio, setRatio] = useState(1.6);
  const frameChanged = useMonitorFrame(task.key, trackFrame);
  const floating = windows.some((item) => item.key === task.key);
  return <article className={styles.card} data-monitor-task={task.key} hidden={task.closed && !task.hasFrame}>
    <div className={styles.identity}>
      <strong title={task.title}>{task.title}</strong>
      <span className={styles.action} title={activity.text}>{activity.text}</span>
    </div>
    <div className={styles.preview} style={{ aspectRatio: ratio }}>
      <BrowserScreenView subagentId={task.workerId} browserId={task.browserId} browserReady={task.ready}
        resourceClosed={task.closed} title={task.title} fidelity={hidden ? 'hidden' : 'visible'}
        fit="full" fps={4} controls={false} retainLastFrame onFrameRatio={setRatio} onFrameChange={frameChanged} />
      <button type="button" className={styles.previewButton} onClick={() => onOpen(task.key)}
        aria-label={t('sessionWorkbenchUi.monitor.openWindow', { name: task.title })}>
        <span>{t(floating ? 'sessionWorkbenchUi.monitor.restoreWindow' : 'sessionWorkbenchUi.monitor.openPreview')}</span>
      </button>
    </div>
    <span className={styles.resourceState}>{t(task.closed ? 'sessionWorkbenchUi.monitor.closed'
      : task.ready ? 'sessionWorkbenchUi.monitor.available' : 'sessionWorkbenchUi.screen.waitingBrowser')}</span>
  </article>;
}

interface ReadingBounds extends MonitorArea { readonly x: number; readonly y: number }
const EMPTY_BOUNDS: ReadingBounds = { x: 0, y: 0, width: 0, height: 0 };

/** The reading element ends above tasks, the pending queue and the composer/Gate. */
function useReadingBounds(readingRef: RefObject<HTMLElement | null>, hostRef: RefObject<HTMLDivElement | null>, scope: string) {
  const [bounds, setBounds] = useState(EMPTY_BOUNDS);
  useLayoutEffect(() => {
    const reading = readingRef.current;
    const host = hostRef.current?.parentElement;
    if (!reading || !host) { setBounds(EMPTY_BOUNDS); return; }
    const measure = () => {
      const rect = reading.getBoundingClientRect();
      const parent = host.getBoundingClientRect();
      const next = { x: rect.left - parent.left, y: rect.top - parent.top, width: rect.width, height: rect.height };
      setBounds((previous) => Object.keys(next).every((key) => previous[key as keyof ReadingBounds] === next[key as keyof ReadingBounds]) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(reading);
    observer.observe(host);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [hostRef, readingRef, scope]);
  return bounds;
}

interface FloatingMonitorProps {
  readonly agentId: string;
  readonly controller: BrowserMonitorController;
  readonly readingRef: RefObject<HTMLElement | null>;
  readonly hidden: boolean;
  readonly onFullscreen: (key: string) => void;
  readonly onReturnToMonitor: (key: string) => void;
}

export function FloatingBrowserMonitors({ agentId, controller, readingRef, hidden, onFullscreen, onReturnToMonitor }: FloatingMonitorProps) {
  const host = useRef<HTMLDivElement>(null);
  const bounds = useReadingBounds(readingRef, host, `${agentId}|${hidden}`);
  const parked = controller.windows.filter((item) => item.minimized);
  const area = { width: bounds.width, height: Math.max(0, bounds.height - (parked.length ? 38 : 0)) };
  const ordered = [...controller.windows].sort((a, b) => a.order - b.order);
  const { t } = useTranslation();
  return <div ref={host} className={styles.layer} data-monitor-layer="true" hidden={hidden}
    style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}>
    {ordered.map((item, index) => {
      const task = controller.tasks.find((candidate) => candidate.key === item.key);
      return task && <FloatingMonitor key={`${agentId}|${item.key}`} agentId={agentId} task={task} item={item}
        area={area} order={index + 1} hidden={hidden} controller={controller} onFullscreen={onFullscreen} onReturnToMonitor={onReturnToMonitor} />;
    })}
    {parked.length > 0 && <div className={styles.parking} data-monitor-parking="true">
      {parked.map((item) => {
        const task = controller.tasks.find((candidate) => candidate.key === item.key);
        return task && <button type="button" key={item.key} title={task.title}
          aria-label={t('sessionWorkbenchUi.monitor.restoreNamed', { name: task.title })}
          onClick={() => controller.open(item.key, area)}>{task.title}</button>;
      })}
    </div>}
  </div>;
}

function FloatingMonitor({ agentId, task, item, area, order, hidden, controller, onFullscreen, onReturnToMonitor }: {
  agentId: string; task: MonitorTask; item: MonitorWindow; area: MonitorArea; order: number; hidden: boolean;
  controller: BrowserMonitorController; onFullscreen: (key: string) => void; onReturnToMonitor: (key: string) => void;
}) {
  const { t } = useTranslation();
  const activity = useWorkerActivity(agentId, task.workerId);
  const cancelGesture = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelGesture.current?.(), []);
  useEffect(() => { if (hidden || item.minimized) cancelGesture.current?.(); }, [hidden, item.minimized]);
  const rect = constrainMonitorRect(item.rect, area);
  const gesture = (event: ReactPointerEvent<HTMLElement>, resize: boolean) => {
    if (event.button !== 0 || (!resize && (event.target as HTMLElement).closest('button'))) return;
    event.preventDefault();
    controller.raise(item.key);
    cancelGesture.current?.();
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    target.setPointerCapture?.(pointerId);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const dx = next.clientX - start.x;
      const dy = next.clientY - start.y;
      const moved: MonitorRect = resize
        ? { ...rect, width: rect.width + dx, height: rect.height + dy }
        : { ...rect, x: rect.x + dx, y: rect.y + dy };
      controller.change(item.key, { rect: constrainMonitorRect(moved, area) });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      cancelGesture.current = null;
    };
    cancelGesture.current = end;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const readyForWindow = !task.closed && task.ready;
  const frameChanged = useMonitorFrame(task.key, controller.trackFrame);
  return <section className={styles.window} role="region" aria-label={task.title} data-monitor-window={task.key}
    hidden={item.minimized} style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: order }}
    onPointerDownCapture={() => controller.raise(item.key)} onFocusCapture={() => controller.raise(item.key)}>
    <header className={styles.windowHeader} onPointerDown={(event) => gesture(event, false)}>
      <strong title={task.title}>{task.title}</strong>
      <button type="button" onClick={() => controller.change(item.key, { minimized: true })}
        aria-label={t('sessionWorkbenchUi.monitor.minimize')} title={t('sessionWorkbenchUi.monitor.minimize')}><Minus size={13} /></button>
      <button type="button" onClick={() => onReturnToMonitor(item.key)}
        aria-label={t('sessionWorkbenchUi.monitor.return')} title={t('sessionWorkbenchUi.monitor.return')}><PanelRightClose size={13} /></button>
    </header>
    <div className={styles.windowAction} title={activity.text}>{activity.text}</div>
    <div className={styles.windowPicture}>
      <BrowserScreenView subagentId={task.workerId} browserId={task.browserId} browserReady={task.ready}
        resourceClosed={task.closed} title={task.title} fidelity={hidden || item.minimized ? 'hidden' : 'visible'}
        fit={item.fit === 'full' ? 'full' : 'fill'} fps={30} controls={false} retainLastFrame onFrameChange={frameChanged} />
    </div>
    <footer className={styles.windowFooter}>
      <button type="button" onClick={() => controller.change(item.key, { fit: item.fit === 'full' ? 'detail' : 'full' })}
        aria-label={t(item.fit === 'full' ? 'sessionWorkbenchUi.monitor.detail' : 'sessionWorkbenchUi.monitor.full')}>
        {item.fit === 'full' ? <ZoomIn size={12} /> : <Scan size={12} />}
        {t(item.fit === 'full' ? 'sessionWorkbenchUi.monitor.detail' : 'sessionWorkbenchUi.monitor.full')}
      </button>
      <button type="button" disabled={!readyForWindow} onClick={() => onFullscreen(task.key)} aria-label={t('sessionWorkbenchUi.screen.fullscreen')}>
        <Maximize2 size={12} />{t('sessionWorkbenchUi.monitor.enlarge')}
      </button>
      <button type="button" disabled={!readyForWindow} onClick={() => void showBrowserWindow(task.browserId)} aria-label={t('sessionWorkbenchUi.screen.showBrowserWindow')}>
        <Eye size={12} />{t('sessionWorkbenchUi.screen.browserWindow')}
      </button>
      <button type="button" className={styles.resize} onPointerDown={(event) => gesture(event, true)}
        aria-label={t('sessionWorkbenchUi.monitor.resize')} onKeyDown={(event) => {
          const keys: Record<string, MonitorRect> = {
            ArrowRight: { ...rect, width: rect.width + 20 }, ArrowLeft: { ...rect, width: rect.width - 20 },
            ArrowDown: { ...rect, height: rect.height + 20 }, ArrowUp: { ...rect, height: rect.height - 20 },
          };
          if (keys[event.key]) { event.preventDefault(); controller.change(item.key, { rect: constrainMonitorRect(keys[event.key]!, area) }); }
        }}>◢</button>
    </footer>
  </section>;
}
