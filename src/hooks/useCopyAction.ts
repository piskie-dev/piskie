import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyStatus = 'idle' | 'copying' | 'success' | 'error';

export interface CopyActionState {
  readonly busy: boolean;
  readonly status: CopyStatus;
  readonly run: (action: () => Promise<void>) => Promise<void>;
}

/** Use a stable key for the displayed content; keep this hook mounted across view changes. */
export function useCopyAction(contentKey: unknown): CopyActionState {
  const [owner, setOwner] = useState({ key: contentKey });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    owner: typeof owner;
    status: 'success' | 'error';
  } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);

  // A new visit gets a new owner even when navigating A → B → A during a copy.
  if (!Object.is(owner.key, contentKey)) setOwner({ key: contentKey });

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await action();
      if (mounted.current) setFeedback({ owner, status: 'success' });
    } catch {
      if (mounted.current) setFeedback({ owner, status: 'error' });
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [owner]);

  return {
    busy,
    status: busy ? 'copying' : feedback?.owner === owner ? feedback.status : 'idle',
    run,
  };
}
