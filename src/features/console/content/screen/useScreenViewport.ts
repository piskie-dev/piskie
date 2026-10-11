import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import type { RemoteInputEvent } from '@shared/types/stream';
import type { PresentedScreenPointer } from '@shared/screen-pointer';
import type {
  ScreenCaptureOptions,
  ScreenViewportFrame,
  ViewportDemand,
} from '@/domains/screen-feed/worker-protocol';
import type {
  ViewportLease,
  ViewportSnapshot,
} from '@/domains/screen-feed/screen-feed';
import { useRendererRuntime } from '@/renderer-runtime/hooks';

const EMPTY_SNAPSHOT: ViewportSnapshot = Object.freeze({
  phase: 'idle',
  epoch: 0,
  failure: null,
  frameSize: null,
  stats: Object.freeze({
    receivedFrames: 0,
    decodedFrames: 0,
    decodeFailures: 0,
    sequenceGaps: 0,
    decodedFps: 0,
    decodeMs: 0,
  }),
  demand: Object.freeze({ fps: 4 }),
  ready: false,
  viewportFailure: null,
  drawnFrames: 0,
  page: null,
  pointer: null,
  pointerClearId: 0,
  renderedFrame: null,
});

interface LeaseSession {
  readonly key: string;
  readonly lease: ViewportLease | null;
  readonly attachError: string | null;
}

export interface ScreenViewportOptions {
  readonly agentId: string;
  readonly browserId: string;
  readonly enabled: boolean;
  readonly fps: number;
  readonly interactive?: boolean;
  readonly paused?: boolean;
  readonly capture?: ScreenCaptureOptions;
  readonly retainLastFrame?: boolean;
}

export interface ScreenViewportState {
  readonly ready: boolean;
  readonly frozen: boolean;
  readonly error: string | null;
  readonly frameSize: { readonly width: number; readonly height: number } | null;
  readonly currentFps: number | null;
  readonly pointer: PresentedScreenPointer | null;
  readonly onPointerPresented: (pointer: PresentedScreenPointer, at: number) => void;
  readonly renderedFrame: ScreenViewportFrame | null;
  readonly canvasKey: string;
  readonly canvasRef: (node: HTMLCanvasElement | null) => void;
  readonly sendInput: (event: RemoteInputEvent) => void;
}

export function useScreenViewport(options: ScreenViewportOptions): ScreenViewportState {
  const { t } = useTranslation();
  const {
    agentId,
    browserId,
    enabled,
    fps,
    interactive = false,
    paused = false,
    capture,
    retainLastFrame = false,
  } = options;
  const { screenFeeds } = useRendererRuntime();
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [canvasVersion, setCanvasVersion] = useState(0);
  const [session, setSession] = useState<LeaseSession | null>(null);
  const sessionKey = `${agentId}:${browserId}:${enabled ? 'on' : 'off'}:${interactive ? 'input' : 'view'}:${canvasVersion}`;
  const activeLease = session?.key === sessionKey ? session.lease : null;
  const attachError = session?.key === sessionKey ? session.attachError : null;
  const quality = capture?.quality;
  const maxWidth = capture?.maxWidth;
  const maxHeight = capture?.maxHeight;
  const demand = useMemo<ViewportDemand>(() => ({
    visible: !paused,
    fps,
    ...(quality !== undefined ? { quality } : {}),
    ...(maxWidth !== undefined ? { maxWidth } : {}),
    ...(maxHeight !== undefined ? { maxHeight } : {}),
  }), [fps, maxHeight, maxWidth, paused, quality]);
  const demandRef = useRef(demand);

  const canvasRef = useCallback((node: HTMLCanvasElement | null) => setCanvas(node), []);
  const subscribe = useCallback(
    (listener: () => void) => activeLease?.subscribe(listener) ?? (() => undefined),
    [activeLease],
  );
  const getSnapshot = useCallback(
    () => activeLease?.snapshot() ?? EMPTY_SNAPSHOT,
    [activeLease],
  );
  const liveSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const lastFrame = useRef<{ key: string; snapshot: ViewportSnapshot } | null>(null);
  const frameKey = `${agentId}:${browserId}:${canvasVersion}`;
  if (enabled && liveSnapshot.ready) lastFrame.current = { key: frameKey, snapshot: liveSnapshot };
  const retained = !enabled && retainLastFrame && lastFrame.current?.key === frameKey
    ? lastFrame.current.snapshot : null;
  const snapshot = retained ?? liveSnapshot;
  const frozen = retained !== null;

  useEffect(() => {
    demandRef.current = demand;
  }, [demand]);

  useEffect(() => {
    if (!enabled || !canvas) return;
    let cancelled = false;
    let lease: ViewportLease | null = null;
    const startTimer = window.setTimeout(() => {
      if (cancelled) return;
      try {
        lease = screenFeeds.acquireViewport({
          agentId,
          browserId,
          interactive,
          demand: demandRef.current,
        });
        const result = lease.attach(canvas);
        if (result === 'replace-canvas') {
          lease.release();
          lease = null;
          if (!cancelled) setCanvasVersion((version) => version + 1);
          return;
        }
        setSession({ key: sessionKey, lease, attachError: null });
      } catch (error) {
        lease?.release();
        lease = null;
        if (!cancelled) {
          setSession({
            key: sessionKey,
            lease: null,
            attachError: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      lease?.release();
    };
  }, [agentId, browserId, canvas, enabled, interactive, screenFeeds, sessionKey]);

  useEffect(() => {
    activeLease?.update(demand);
  }, [activeLease, demand]);

  const sendInput = useCallback((event: RemoteInputEvent) => {
    activeLease?.sendInput(event);
  }, [activeLease]);
  const onPointerPresented = useCallback((pointer: PresentedScreenPointer, at: number) => {
    activeLease?.pointerPresented(pointer, at);
  }, [activeLease]);
  const feedbackCleared = !snapshot.pointer?.press;
  useLayoutEffect(() => {
    if (feedbackCleared && snapshot.pointerClearId > 0) activeLease?.pointerCleared(snapshot.pointerClearId);
  }, [activeLease, feedbackCleared, snapshot.pointerClearId]);
  const failure = snapshot.viewportFailure ?? snapshot.failure;

  return {
    ready: snapshot.ready,
    frozen,
    error: attachError ?? screenFailureText(failure, t),
    frameSize: snapshot.frameSize,
    currentFps: frozen || snapshot.phase === 'idle' ? null : snapshot.stats.decodedFps,
    pointer: paused || frozen ? null : snapshot.pointer,
    onPointerPresented,
    renderedFrame: snapshot.renderedFrame,
    canvasKey: `browser-${browserId}-${canvasVersion}`,
    canvasRef,
    sendInput,
  };
}

function screenFailureText(
  failure: ViewportSnapshot['failure'],
  t: TFunction,
): string | null {
  if (!failure) return null;
  if (failure.code === 'port-request-timeout') {
    return t('sessionWorkbenchUi.screen.portTimeout');
  }
  if (failure.code === 'port-response-missing') {
    return t('sessionWorkbenchUi.screen.portMissing');
  }
  if (failure.detail && (
    failure.code === 'canvas-transfer-failed'
    || failure.code === 'decode-failed'
    || failure.code === 'decode-stalled'
    || failure.code === 'port-request-failed'
    || failure.code === 'worker-crashed'
  )) {
    return failure.detail;
  }
  return t('sessionWorkbenchUi.screen.streamUnavailable');
}
