import { describe, expect, it } from 'vitest';
import type { AgentControlSnapshot } from '@shared/electron-contracts/agent-runs';
import { hasUnreadMessages, mergeMessageState } from '@shared/agent-run-messages';
import { projectActiveAgentRun } from '../agentRunViewModel';
import { relativeMessageTime } from '../messageTime';

function control(overrides: Partial<AgentControlSnapshot> = {}): AgentControlSnapshot {
  return {
    agentId: 'sample-main', phase: 'waiting', runConfig: { name: 'Example' }, children: [],
    ...overrides,
  } as AgentControlSnapshot;
}
describe('sidebar activity and message projection', () => {
  it('animates actual execution in the main or children, without treating standby or blocked work as running', () => {
    const working = (value: AgentControlSnapshot) => projectActiveAgentRun(value, 'Example').working;
    expect(working(control({ phase: 'thinking' }))).toBe(true);
    expect(working(control({ phase: 'executing' }))).toBe(true);
    expect(working(control())).toBe(false);
    expect(working(control({ phase: 'stopping' }))).toBe(false);
    expect(working(control({ phase: 'thinking', interrupted: true }))).toBe(false);
    expect(working(control({ phase: 'executing', pendingToolCall: { toolName: 'example' } as never }))).toBe(false);
    expect(working(control({ phase: 'thinking', pendingQuestion: { questions: [] } as never }))).toBe(false);
    expect(working(control({ children: [{ phase: 'executing' }] as never }))).toBe(true);
    expect(working(control({ children: [{ phase: 'waiting' }] as never }))).toBe(false);
    expect(working(control({ children: [{ phase: 'thinking', interrupted: true }] as never }))).toBe(false);
  });

  it('merges read acknowledgements with newer messages without losing either position', () => {
    const current = { latestMessage: { index: 9, timestamp: 9000 }, latestAssistantIndex: 9, readThroughIndex: 3 };
    const older = { latestMessage: { index: 7, timestamp: 7000 }, latestAssistantIndex: 7, readThroughIndex: 7 };
    const merged = mergeMessageState(current, older);
    expect(merged).toEqual({ ...current, readThroughIndex: 7 });
    expect(hasUnreadMessages(merged)).toBe(true);
    expect(mergeMessageState(older, current)).toEqual(merged);
  });

  it.each([
    [0, 'now', 0], [59_999, 'now', 0], [60_000, 'minute', 1], [180_000, 'minute', 3],
    [7_200_000, 'hour', 2], [8 * 86_400_000, 'day', 8],
    [40 * 86_400_000, 'month', 1], [400 * 86_400_000, 'year', 1],
  ])('formats elapsed %i without an activity timestamp', (elapsed, unit, count) => {
    expect(relativeMessageTime(1000, 1000 + elapsed)).toMatchObject({ unit, count });
  });
  it('updates at the next minute boundary and keeps future clock skew at just now', () => {
    expect(relativeMessageTime(1000, 60_999).nextUpdateIn).toBe(1);
    expect(relativeMessageTime(2000, 1000).unit).toBe('now');
  });
});
