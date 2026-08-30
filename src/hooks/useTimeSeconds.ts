import { useEffect, useState } from 'react';

export type TimeSecondsMode = 'elapsed' | 'remaining';

interface ClockSample {
  readonly timestamp: number | undefined;
  readonly sampledAt: number;
}

function measureSeconds(timestamp: number, sampledAt: number, mode: TimeSecondsMode): number {
  const milliseconds = mode === 'elapsed'
    ? sampledAt - timestamp
    : timestamp - sampledAt;
  const round = mode === 'elapsed' ? Math.floor : Math.ceil;
  return Math.max(0, round(milliseconds / 1000));
}

/** Refreshes a whole-second value measured from or toward an absolute timestamp. */
export function useTimeSeconds(
  timestamp: number | undefined,
  mode: TimeSecondsMode,
): number {
  // eslint-disable-next-line react-hooks/purity -- The clock needs a real initial sample.
  const [sample, setSample] = useState<ClockSample>(() => ({ timestamp, sampledAt: Date.now() }));

  useEffect(() => {
    if (timestamp === undefined) return;

    const refresh = () => setSample({ timestamp, sampledAt: Date.now() });
    const initialRefresh = setTimeout(refresh, 0);
    const interval = setInterval(refresh, 1000);
    return () => {
      clearTimeout(initialRefresh);
      clearInterval(interval);
    };
  }, [timestamp]);

  if (timestamp === undefined) return 0;
  if (sample.timestamp !== timestamp) {
    // eslint-disable-next-line react-hooks/purity -- Avoid showing a stale clock when the timestamp changes.
    return measureSeconds(timestamp, Date.now(), mode);
  }
  return measureSeconds(timestamp, sample.sampledAt, mode);
}
