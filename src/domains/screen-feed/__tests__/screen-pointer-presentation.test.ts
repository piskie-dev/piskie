import { describe, expect, it, vi } from 'vitest';
import type { ScreenPointer } from '@shared/types/stream';
import { SCREEN_POINTER_POLICY } from '@shared/screen-pointer';
import { ScreenPointerPresentation } from '../screen-pointer-presentation';

const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
function harness(visible = true) {
  let time = 10_000;
  const tasks: Array<{ at: number; active: boolean; callback: () => void }> = [];
  const publish = vi.fn();
  const resume = vi.fn();
  const controller = new ScreenPointerPresentation(visible, {
    now: () => time,
    unixNow: () => time,
    publish, resume,
    scheduleDelay: (callback, delayMs) => {
      const task = { at: time + delayMs, active: true, callback };
      tasks.push(task);
      return () => { task.active = false; };
    },
  });
  const click = (seq = 3): ScreenPointer => ({ page, seq, x: 80, y: 120,
    buttons: 0, action: 'up', clickCount: 1, timestamp: time,
    press: { page, seq: seq - 1, x: 80, y: 120, timestamp: time, clickCount: 1 } });
  const advance = (ms: number) => {
    const end = time + ms;
    for (;;) {
      const next = tasks.filter((task) => task.active && task.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      time = next.at;
      next.active = false;
      next.callback();
    }
    time = end;
  };
  return { controller, click, advance, publish, resume, tasks, now: () => time };
}

describe('ScreenPointerPresentation', () => {
  it.each([450, 1500])('starts a viewport clock after a %ims matching frame wait without changing source time', (delay) => {
    const test = harness();
    const click = test.click();
    test.controller.accept(page, click);
    expect(test.controller.pointer).toBeNull();
    test.advance(delay);
    test.controller.drawn(page);
    expect(test.controller.pointer).toMatchObject({ ...click, visibleAt: null, pressVisibleAt: null });
    test.controller.presented(page, click.seq, click.press!.seq, test.now());
    expect(test.controller.pointer).toMatchObject({ timestamp: click.timestamp,
      visibleAt: test.now(), pressVisibleAt: test.now() });
  });

  it('admits a current position after transport or first-viewer waiting and expires only press feedback', () => {
    const test = harness();
    const click = test.click();
    test.controller.drawn(page);
    test.advance(1500);
    test.controller.accept(page, click);
    expect(test.controller.pointer?.press).toEqual(click.press);
    const stale = harness();
    const old = stale.click();
    stale.advance(SCREEN_POINTER_POLICY.pressFreshnessMs + 1);
    stale.controller.accept(page, old);
    stale.controller.drawn(page);
    expect(stale.controller.pointer).toMatchObject({ x: old.x, y: old.y, timestamp: old.timestamp, press: undefined });
  });

  it('holds old-frame feedback, clears only the press and keeps the real Page position on the new frame', () => {
    const test = harness();
    const click = test.click();
    const next = { ...page, navigationSequence: 1 };
    test.controller.drawn(page);
    test.controller.accept(page, click);
    test.controller.accept(next, click);
    expect(test.controller.canDraw(next)).toBe(false);
    test.advance(20);
    test.controller.presented(page, click.seq, click.press!.seq, test.now());
    test.advance(SCREEN_POINTER_POLICY.navigationVisibleMs - 1);
    expect(test.controller.pointer?.page).toEqual(page);
    test.advance(1);
    expect(test.controller.pointer).toMatchObject({ page, framePage: page, press: undefined });
    expect(test.controller.canDraw(next)).toBe(false);
    test.controller.cleared(test.controller.clearId);
    expect(test.controller.canDraw(next)).toBe(true);
    test.controller.drawn(next);
    expect(test.controller.pointer).toMatchObject({ page, framePage: next, seq: click.seq,
      x: click.x, y: click.y, timestamp: click.timestamp, press: undefined });
    expect(test.resume).toHaveBeenCalledOnce();
  });

  it('waits for arriving click feedback instead of spending its visible window on the arrow movement', () => {
    const test = harness();
    const click = test.click();
    const next = { ...page, navigationSequence: 1 };
    test.controller.drawn(page);
    test.controller.accept(page, click);
    test.controller.accept(next, click);
    test.advance(20);
    test.controller.presented(page, click.seq, undefined, test.now());
    test.advance(SCREEN_POINTER_POLICY.motionMs);
    expect(test.controller.pointer?.pressVisibleAt).toBeNull();
    test.controller.presented(page, click.seq, click.press!.seq, test.now());
    test.advance(SCREEN_POINTER_POLICY.navigationVisibleMs - 1);
    expect(test.controller.pointer).not.toBeNull();
    test.advance(1);
    expect(test.controller.pointer).toMatchObject({ page, framePage: page, press: undefined });
    expect(test.controller.canDraw(next)).toBe(false);
    test.controller.cleared(test.controller.clearId);
    expect(test.controller.canDraw(next)).toBe(true);
  });

  it('shows the real position on a new same-Page frame without inventing an old image or replaying its press', () => {
    const test = harness();
    const click = test.click();
    test.controller.accept(page, click);
    const next = { ...page, navigationSequence: 1 };
    test.controller.accept(next, click);
    expect(test.controller.canDraw(next)).toBe(true);
    test.controller.drawn(next);
    expect(test.controller.pointer).toMatchObject({ page, framePage: next, timestamp: click.timestamp, press: undefined });
  });

  it('caps feedback waiting across rapid navigations and ignores obsolete clear acknowledgements', () => {
    const test = harness();
    test.controller.drawn(page);
    const click = test.click();
    test.controller.accept(page, click);
    test.controller.accept({ ...page, navigationSequence: 1 }, click);
    test.advance(200);
    const latest = { ...page, navigationSequence: 2 };
    test.controller.accept(latest, click);
    test.advance(SCREEN_POINTER_POLICY.navigationMaxDelayMs - 201);
    expect(test.controller.pointer).not.toBeNull();
    test.advance(1);
    expect(test.controller.pointer).toMatchObject({ page, press: undefined });
    test.controller.cleared(test.controller.clearId - 1);
    expect(test.controller.canDraw(latest)).toBe(false);
    test.controller.cleared(test.controller.clearId);
    expect(test.controller.canDraw(latest)).toBe(true);
  });

  it('keeps a hover through same-Page navigation without a clear gap or a synthetic source observation', () => {
    const test = harness();
    const source = { ...test.click(), action: 'move' as const, press: undefined };
    test.controller.drawn(page);
    test.controller.accept(page, source);
    const original = test.controller.pointer;
    const next = { ...page, navigationSequence: 1 };
    test.controller.accept(next, source);
    expect(test.controller.pointer).toBe(original);
    expect(test.controller.blocked).toBe(false);
    expect(test.controller.canDraw(next)).toBe(true);
    test.controller.drawn(next);
    expect(test.controller.pointer).toMatchObject({ ...source, framePage: next });
    expect(test.controller.clearId).toBe(0);
  });

  it('does not use a later observation frame as the origin of an earlier press', () => {
    const test = harness();
    const click = test.click();
    const next = { ...page, navigationSequence: 1 };
    const up = { ...click, page: next, seq: click.seq + 1 };
    test.controller.accept(next, up);
    test.controller.drawn(next);
    expect(test.controller.pointer).toMatchObject({ page: next, framePage: next, press: undefined });
    expect(up.press!.page).toBe(page);
  });

  it('suppresses feedback observed while hidden and does not revive an old press on a later move', () => {
    const test = harness();
    const click = test.click();
    test.controller.drawn(page);
    test.controller.accept(page, click);
    test.controller.presented(page, click.seq, click.press!.seq, test.now());
    test.controller.setVisible(false);
    test.controller.accept(page, { ...click, seq: 4 });
    test.controller.setVisible(true);
    expect(test.controller.pointer).toMatchObject({ seq: 4, x: click.x, y: click.y, press: undefined });
    test.controller.setVisible(false);
    test.advance(6000);
    test.controller.setVisible(true);
    expect(test.controller.pointer).toMatchObject({ seq: 4, x: click.x, y: click.y, press: undefined });
    test.controller.accept(page, { ...click, seq: 5, action: 'move' });
    expect(test.controller.pointer).toMatchObject({ seq: 5, press: undefined, visibleAt: null });
    test.controller.accept(page, test.click(7));
    expect(test.controller.pointer?.press?.seq).toBe(6);
    test.controller.accept({ ...page, navigationSequence: 1 }, null);
    test.controller.setVisible(false);
    expect(test.controller.blocked).toBe(false);
    expect(test.tasks.filter((task) => task.active)).toHaveLength(0);
  });

  it.each([null, { ...page, pageId: 2 }, { ...page, connectionId: 'sample-recovered' }])(
    'clears on close, selection or recovery instead of holding old coordinates for %j', (target) => {
      const test = harness();
      const click = test.click();
      test.controller.drawn(page);
      test.controller.accept(page, click);
      test.controller.accept({ ...page, navigationSequence: 1 }, null);
      test.controller.accept(target, null);
      expect(test.controller.pointer).toBeNull();
      expect(test.tasks.filter((task) => task.active)).toHaveLength(0);
      test.controller.cleared(test.controller.clearId);
      expect(test.controller.canDraw(target)).toBe(true);
    });

  it('presents target/state revisions without rewriting source seq/time and suppresses hidden highlights', () => {
    const test = harness();
    const original = { ...test.click(), press: undefined, action: 'move' as const };
    const target = { page, seq: 10, timestamp: test.now(), kind: 'input' as const, actor: 'ai' as const,
      x: 500, y: 200, rect: { x: 400, y: 180, width: 200, height: 40 }, scrollX: 0, scrollY: 0 };
    const source = { ...original, revision: 11, target, activity: { page, seq: 10, timestamp: test.now(), kind: 'input' as const, actor: 'ai' as const, pending: false } };
    test.controller.accept(page, source);
    expect(test.controller.pointer).toBeNull();
    test.controller.drawn(page);
    test.controller.presented(page, 11, undefined, test.now(), 10, 10);
    expect(test.controller.pointer).toMatchObject({ seq: original.seq, timestamp: original.timestamp, targetVisibleAt: test.now(), activityVisibleAt: test.now() });
    test.controller.setVisible(false);
    test.controller.accept(page, { ...source, revision: 12, target: { ...target, seq: 12 } });
    test.controller.setVisible(true);
    expect(test.controller.pointer).toMatchObject({ target: { seq: 12 }, targetSuppressed: true, activity: undefined });
    const next = { ...page, navigationSequence: 1 };
    test.controller.accept(next, source);
    test.controller.drawn(next);
    expect(test.controller.pointer).toMatchObject({ target: undefined, positionTarget: target, framePage: next, seq: original.seq });
    test.controller.dispose();
    expect(test.tasks.filter((task) => task.active)).toHaveLength(0);
  });

  it('fences old presentation by identity and resets clocks, sources and timers at a new feed epoch', () => {
    const test = harness();
    const click = test.click();
    test.controller.drawn(page);
    test.controller.accept(page, click);
    test.controller.accept({ ...page, navigationSequence: 1 }, null);
    test.controller.reset();
    expect(test.tasks.filter((task) => task.active)).toHaveLength(0);
    test.controller.drawn(page);
    expect(test.controller.pointer).toBeNull();
    const recovered = { ...page, connectionId: 'sample-recovered' };
    test.controller.drawn(recovered);
    test.controller.accept(recovered, { ...click, page: recovered, press: { ...click.press!, page: recovered } });
    test.controller.presented(page, click.seq, click.press!.seq, test.now());
    expect(test.controller.pointer?.visibleAt).toBeNull();
    test.controller.presented(recovered, click.seq, click.press!.seq, test.now());
    expect(test.controller.pointer?.visibleAt).toBe(test.now());
    test.controller.accept({ ...recovered, navigationSequence: 1 }, null);
    test.controller.dispose();
    expect(test.tasks.filter((task) => task.active)).toHaveLength(0);
    const published = test.publish.mock.calls.length;
    test.advance(1000);
    expect(test.publish).toHaveBeenCalledTimes(published);
  });
});
