import { interval } from './planTimeline';

/** Use the demo clock so click feedback stays aligned through pauses and scene changes. */
export function paintGuideClick(cursor: HTMLElement, time: number, clicks: readonly number[]) {
  const latest = clicks.reduce((previous, at) => at <= time ? Math.max(previous, at) : previous, -Infinity);
  const age = time - latest;
  cursor.style.setProperty('--guide-click', String(1 - interval(age, 100, 650)));
  cursor.style.setProperty('--guide-click-progress', String(interval(age, 0, 650)));
  cursor.style.setProperty('--guide-press', String(1 - interval(age, 0, 180)));
}
