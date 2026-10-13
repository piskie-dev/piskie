import type { WorkerRef } from '../../data/vm';

export interface MonitorTask {
  readonly key: string;
  readonly workerId: string;
  readonly browserId: string;
  readonly title: string;
  readonly ready: boolean;
  readonly closed: boolean;
  readonly hasFrame: boolean;
}

export function reconcileMonitorTasks(previous: readonly MonitorTask[], workers: readonly WorkerRef[]): MonitorTask[] {
  const previousByKey = new Map(previous.map((task) => [task.key, task]));
  const tasks = new Map<string, MonitorTask>();
  for (const worker of workers) {
    if (!worker.browserId) continue;
    const key = `${worker.id}|${worker.browserId}`;
    tasks.set(key, {
      key, workerId: worker.id, browserId: worker.browserId, title: worker.subject,
      ready: worker.browserReady === true, closed: false,
      hasFrame: previousByKey.get(key)?.hasFrame ?? false,
    });
  }
  return [...tasks.values()];
}

export interface MonitorArea { readonly width: number; readonly height: number }
export interface MonitorRect extends MonitorArea { readonly x: number; readonly y: number }
export interface MonitorWindow {
  readonly key: string;
  readonly rect: MonitorRect;
  readonly minimized: boolean;
  readonly fit: 'full' | 'detail';
  readonly order: number;
}

/** Every rendered window fits inside the reading area, including after layout/Gate changes. */
export function constrainMonitorRect(rect: MonitorRect, area: MonitorArea): MonitorRect {
  const width = Math.min(Math.max(240, rect.width), Math.max(0, area.width));
  const height = Math.min(Math.max(150, rect.height), Math.max(0, area.height));
  return {
    width, height,
    x: Math.max(0, Math.min(rect.x, area.width - width)),
    y: Math.max(0, Math.min(rect.y, area.height - height)),
  };
}

export function initialMonitorRect(area: MonitorArea, index: number): MonitorRect {
  const width = Math.min(560, area.width * 0.85);
  return constrainMonitorRect({ x: 16 + index * 24, y: 16 + index * 24, width, height: width / 1.6 + 92 }, area);
}
