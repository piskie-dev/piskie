import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FilePreviewDescriptor } from '@shared/electron-contracts/desktop';
import { PiskieFault } from '@shared/electron-contracts/public-fault';
import { releaseUnusedPreview, type ReviewableFilePreview } from './fileReviewTarget';

interface LiveState {
  readonly revision: string | null | undefined;
  readonly busy: boolean;
  readonly error: string | null;
  readonly success: { readonly revision: string } | null;
}

export type LivePreviewStatus = 'current' | 'changed' | 'missing' | 'refreshing' | 'error';

/** Only metadata changes automatically. The displayed descriptor remains owned by the host. */
export function useLiveFilePreview(
  path: string,
  descriptor: ReviewableFilePreview,
  onRefresh: (expected: ReviewableFilePreview, next: FilePreviewDescriptor) => void,
) {
  const [state, setState] = useState<LiveState>({ revision: undefined, busy: false, error: null, success: null });
  const current = useRef({ active: false, request: 0, metadata: 0, descriptor, onRefresh, state, resumeObservation: (): void => undefined });
  const publish = useCallback((patch: Partial<LiveState>) => {
    const previous = current.current.state;
    const next = { ...previous, ...patch };
    if (next.success && (next.error !== null || (next.revision !== undefined && next.revision !== next.success.revision))) next.success = null;
    if (previous.revision === next.revision && previous.busy === next.busy && previous.error === next.error && previous.success === next.success) return;
    current.current.state = next;
    setState(next);
  }, []);
  const reportError = useCallback((error: unknown) => {
    if (error instanceof PiskieFault && error.code === 'not-found') {
      publish({ revision: null, error: null });
    } else {
      publish({ error: error instanceof Error ? error.message : typeof error === 'string' ? error : '' });
    }
  }, [publish]);

  useEffect(() => {
    if (!state.success) return;
    const timer = window.setTimeout(() => publish({ success: null }), 1_200);
    return () => window.clearTimeout(timer);
  }, [state.success, publish]);

  useLayoutEffect(() => {
    const owner = current.current;
    owner.onRefresh = onRefresh;
    if (owner.descriptor !== descriptor) {
      owner.descriptor = descriptor;
      owner.request += 1;
      owner.metadata += 1;
      publish({ busy: false, error: null, ...(owner.state.success?.revision !== descriptor.revision && { success: null }) });
      owner.resumeObservation();
    }
  }, [descriptor, onRefresh, publish]);

  const checkRevision = useCallback(async () => {
    const owner = current.current;
    const sequence = ++owner.metadata;
    try {
      const revision = await window.piskie.desktop.files.revision(path);
      if (owner.active && sequence === owner.metadata) publish({ revision, ...(revision === null && { error: null }) });
    } catch (error) {
      if (owner.active && sequence === owner.metadata) reportError(error);
    }
  }, [path, publish, reportError]);

  useLayoutEffect(() => {
    const owner = current.current;
    owner.active = true;
    let stop: (() => void) | undefined;
    let subscription = 0;
    const pause = () => {
      subscription += 1;
      stop?.();
      stop = undefined;
      owner.metadata += 1;
    };
    const resume = () => {
      if (stop || document.visibilityState === 'hidden') return;
      const generation = ++subscription;
      try {
        const unsubscribe = window.piskie.desktop.files.observe(path, (revision) => {
          if (!owner.active || generation !== subscription) return;
          owner.metadata += 1;
          publish({ revision, ...(revision === null && { error: null }) });
        }, (error) => {
          if (!owner.active || generation !== subscription) return;
          pause();
          reportError(error);
        });
        if (owner.active && generation === subscription) stop = unsubscribe;
        else unsubscribe();
      } catch (error) { pause(); reportError(error); }
    };
    owner.resumeObservation = resume;
    const focus = () => {
      if (document.visibilityState !== 'hidden') void checkRevision();
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') pause();
      else { resume(); void checkRevision(); }
    };
    resume();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      owner.active = false;
      owner.resumeObservation = () => undefined;
      owner.request += 1;
      pause();
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [path, checkRevision, publish, reportError]);

  const refresh = useCallback(async () => {
    const owner = current.current;
    if (!owner.active || owner.state.busy) return;
    const request = ++owner.request;
    const expected = owner.descriptor;
    const isCurrent = () => owner.active && owner.request === request && owner.descriptor === expected;
    publish({ busy: true, error: null, success: null });
    let preview: FilePreviewDescriptor | undefined;
    try {
      preview = await window.piskie.desktop.files.preview(path);
      if (!isCurrent()) { releaseUnusedPreview(preview); return; }
      // Recheck after reading: a write during the read may precede the debounced watch event.
      await checkRevision();
      if (!isCurrent()) { releaseUnusedPreview(preview); return; }
      if (owner.state.revision === null || owner.state.error !== null) {
        releaseUnusedPreview(preview);
        publish({ busy: false });
        return;
      }
      const next = preview;
      preview = undefined;
      owner.onRefresh(expected, next);
      publish({ busy: false, error: null, success: { revision: next.revision } });
    } catch (error) {
      if (preview) releaseUnusedPreview(preview);
      if (isCurrent()) { reportError(error); publish({ busy: false }); }
    }
  }, [path, checkRevision, publish, reportError]);

  const changed = state.revision !== undefined && state.revision !== descriptor.revision;
  const status: LivePreviewStatus = state.busy ? 'refreshing'
    : state.revision === null ? 'missing'
      : state.error !== null ? 'error'
        : changed ? 'changed' : 'current';
  return { status, changed, error: state.error, success: state.success?.revision === descriptor.revision, refresh };
}
