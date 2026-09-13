const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function relativeMessageTime(timestamp: number, now: number) {
  const elapsed = Math.max(0, now - timestamp);
  const [unit, duration] = elapsed < MINUTE ? ['now', MINUTE] as const
    : elapsed < HOUR ? ['minute', MINUTE] as const
      : elapsed < DAY ? ['hour', HOUR] as const
        : elapsed < MONTH ? ['day', DAY] as const
          : elapsed < YEAR ? ['month', MONTH] as const
            : ['year', YEAR] as const;
  return {
    unit,
    count: Math.floor(elapsed / duration),
    // Wake on the next label boundary, including a transition to a larger unit.
    nextUpdateIn: Math.min(duration - elapsed % duration, DAY),
  };
}
