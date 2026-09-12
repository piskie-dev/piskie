export const PLAN_GUIDE_DURATION = 20900;
export const PLAN_GUIDE_STILL = 15100;

export const interval = (time: number, start: number, end: number): number => (
  Math.max(0, Math.min(1, (time - start) / (end - start)))
);

export function planGuideFrame(elapsed: number) {
  const clock = Math.max(0, elapsed) % PLAN_GUIDE_DURATION;
  const time = clock > 20450 ? 0 : Math.min(clock, 20000);
  return {
    time,
    opacity: clock < 20000 ? 1 : clock < 20450
      ? 1 - interval(clock, 20000, 20450)
      : interval(clock, 20450, PLAN_GUIDE_DURATION),
    scene: time < 5100 ? 'setup' : time < 16200 ? 'plan' : 'execution',
    taskTyping: interval(time, 200, 1500),
    menuOpen: time >= 2150 && time < 3700,
    planSelected: time >= 3300,
    gateOpacity: interval(time, 6900, 7350),
    feedbackTyping: interval(time, 9900, 11300),
    feedbackVisible: time >= 9900 && time < 12500,
    revising: time >= 12000 && time < 13000,
    revised: time >= 13000,
  } as const;
}

export function typedText(text: string, progress: number): string {
  const characters = Array.from(text);
  return characters.slice(0, Math.floor(characters.length * progress)).join('');
}
