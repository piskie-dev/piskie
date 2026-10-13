import { describe, expect, it } from 'vitest';
import { constrainMonitorRect, initialMonitorRect, reconcileMonitorTasks } from '../monitorState';
import type { WorkerRef } from '../../../data/vm';

const task: WorkerRef = { id: 'sample-worker', subject: 'Sample task', type: 'browser-worker', status: 'waiting', browserId: 'sample-browser', browserReady: false };
describe('monitor resource lifecycle', () => {
  it('includes an allocated browser before ready and retains task completion during the backend grace period', () => {
    const allocated = reconcileMonitorTasks([], [task]);
    expect(allocated[0]).toMatchObject({ ready: false, closed: false, hasFrame: false });
    const completed = reconcileMonitorTasks(allocated, [{ ...task, browserReady: true,
      taskState: { inputAt: 1, notification: { type: 'completed', at: 2 } },
    }]);
    expect(completed[0]).toMatchObject({ ready: true, closed: false });
    const closed = reconcileMonitorTasks(completed.map((item) => ({ ...item, hasFrame: true })), []);
    expect(closed).toEqual([]);
  });
  it('replaces the previous browser key without carrying its captured picture into the new browser', () => {
    const old = reconcileMonitorTasks([], [task]).map((item) => ({ ...item, hasFrame: true }));
    const next = reconcileMonitorTasks(old, [{ ...task, browserId: 'sample-next-browser' }]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ key: 'sample-worker|sample-next-browser', closed: false, hasFrame: false });
  });
  it('removes departed browsers while preserving the current browser and its frame', () => {
    const remaining = { ...task, id: 'sample-other-worker', browserId: 'sample-other-browser', browserReady: true };
    const previous = reconcileMonitorTasks([], [task, remaining]).map((item) => ({ ...item, hasFrame: true }));
    expect(reconcileMonitorTasks(previous, [remaining])).toEqual([previous[1]]);
    expect(reconcileMonitorTasks(previous, [{ ...task, browserId: undefined }])).toEqual([]);
  });
  it('keeps an allocated browser while readiness changes', () => {
    const previous = reconcileMonitorTasks([], [{ ...task, browserReady: true }]);
    expect(reconcileMonitorTasks(previous, [task])[0]).toMatchObject({ ready: false, closed: false });
  });
});
describe('floating monitor geometry', () => {
  it.each([{ width: 760, height: 550 }, { width: 360, height: 180 }, { width: 200, height: 70 }])('contains the entire window inside the reading region %j', (area) => {
    for (const rect of [initialMonitorRect(area, 0), initialMonitorRect(area, 20),
      constrainMonitorRect({ x: -200, y: 900, width: 1900, height: 1200 }, area)]) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(area.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(area.height);
    }
  });
  it('clamps the displayed geometry without losing the original restore rectangle', () => {
    const saved = { x: 130, y: 70, width: 560, height: 420 };
    expect(constrainMonitorRect(saved, { width: 360, height: 180 })).toEqual({ x: 0, y: 0, width: 360, height: 180 });
    expect(constrainMonitorRect(saved, { width: 900, height: 700 })).toEqual(saved);
  });
});
