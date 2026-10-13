import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkerRef } from '../../data/vm';
import { initialMonitorRect, reconcileMonitorTasks, type MonitorArea, type MonitorTask, type MonitorWindow } from './monitorState';

const NO_WORKERS: readonly WorkerRef[] = [];
const NO_TASKS: readonly MonitorTask[] = [];
const NO_WINDOWS: readonly MonitorWindow[] = [];

/** UI lifetime only; selections and geometry are scoped to the parent conversation. */
export function useBrowserMonitor(scope: string, workers: readonly WorkerRef[] = NO_WORKERS) {
  const [collections, setCollections] = useState<ReadonlyMap<string, readonly MonitorTask[]>>(() => new Map());
  const [windowsByScope, setWindowsByScope] = useState<ReadonlyMap<string, readonly MonitorWindow[]>>(() => new Map());
  const tasks = useMemo(() => reconcileMonitorTasks(collections.get(scope) ?? NO_TASKS, workers), [collections, scope, workers]);
  useEffect(() => {
    setCollections((current) => new Map(current).set(scope, reconcileMonitorTasks(current.get(scope) ?? NO_TASKS, workers)));
  }, [scope, workers]);
  const taskKeys = useMemo(() => new Set(tasks.map((task) => task.key)), [tasks]);
  const savedWindows = windowsByScope.get(scope) ?? NO_WINDOWS;
  const windows = useMemo(() => savedWindows.filter((item) => taskKeys.has(item.key)), [savedWindows, taskKeys]);
  useEffect(() => {
    setWindowsByScope((current) => {
      const saved = current.get(scope) ?? NO_WINDOWS;
      const remaining = saved.filter((item) => taskKeys.has(item.key));
      return remaining.length === saved.length ? current : new Map(current).set(scope, remaining);
    });
  }, [scope, taskKeys]);
  const updateWindows = useCallback((change: (current: readonly MonitorWindow[]) => readonly MonitorWindow[]) => {
    setWindowsByScope((current) => new Map(current).set(scope, change(current.get(scope) ?? NO_WINDOWS)));
  }, [scope]);
  const frames = useRef(new Set<{ scope: string; key: string }>());
  const trackFrame = useCallback((key: string) => {
    const owner = { scope, key };
    let active = true;
    const publish = () => setCollections((current) => {
      const existing = current.get(scope) ?? NO_TASKS;
      const hasFrame = [...frames.current].some((frame) => frame.scope === scope && frame.key === key);
      const task = existing.find((item) => item.key === key);
      if (!task || task.hasFrame === hasFrame) return current;
      return new Map(current).set(scope, existing.map((task) => task.key === key ? { ...task, hasFrame } : task));
    });
    return {
      setAvailable: (available: boolean) => {
        if (!active || frames.current.has(owner) === available) return;
        if (available) frames.current.add(owner);
        else frames.current.delete(owner);
        publish();
      },
      release: () => {
        active = false;
        if (frames.current.delete(owner)) publish();
      },
    };
  }, [scope]);
  const open = useCallback((key: string, area: MonitorArea) => updateWindows((current) => {
    const order = Math.max(0, ...current.map((item) => item.order)) + 1;
    const existing = current.find((item) => item.key === key);
    return existing
      ? current.map((item) => item.key === key ? { ...item, minimized: false, order } : item)
      : [...current, { key, rect: initialMonitorRect(area, current.length), minimized: false, fit: 'detail', order }];
  }), [updateWindows]);
  const change = useCallback((key: string, update: Partial<Omit<MonitorWindow, 'key'>>) => {
    updateWindows((current) => current.map((item) => item.key === key ? { ...item, ...update } : item));
  }, [updateWindows]);
  const raise = useCallback((key: string) => updateWindows((current) => {
    const highest = Math.max(0, ...current.map((item) => item.order));
    if (current.find((item) => item.key === key)?.order === highest) return current;
    const order = highest + 1;
    return current.map((item) => item.key === key ? { ...item, order } : item);
  }), [updateWindows]);
  const close = useCallback((key: string) => updateWindows((current) => current.filter((item) => item.key !== key)), [updateWindows]);
  return { tasks, windows, trackFrame, open, change, raise, close };
}
export type BrowserMonitorController = ReturnType<typeof useBrowserMonitor>;
