/** Short pauses between actions; the demonstration finishes on the saved configuration. */
export const AGENT_GUIDE_TIMING = {
  step: 2500,
  moveStart: 200,
  moveEnd: 950,
  click: 1150,
  result: 1350,
  appearStart: 0,
  appearEnd: 180,
} as const;

export const AGENT_GUIDE_DURATION = 6 * AGENT_GUIDE_TIMING.step;
