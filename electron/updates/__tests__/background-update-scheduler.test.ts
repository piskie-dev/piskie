import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundUpdateScheduler } from '../background-update-scheduler.js';

afterEach(() => vi.useRealTimers());

describe('BackgroundUpdateScheduler', () => {
  it('checks the application and model catalog together after startup and every two hours', async () => {
    vi.useFakeTimers();
    const checkApplication = vi.fn(async () => undefined);
    const refreshCatalog = vi.fn(async () => undefined);
    const scheduler = new BackgroundUpdateScheduler({
      checkApplication, refreshCatalog, applicationChecksEnabled: true,
    });

    scheduler.start();
    scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(checkApplication).not.toHaveBeenCalled();
    expect(refreshCatalog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(checkApplication).toHaveBeenCalledOnce();
    expect(refreshCatalog).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000 - 1);
    expect(checkApplication).toHaveBeenCalledOnce();
    expect(refreshCatalog).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(checkApplication).toHaveBeenCalledTimes(2);
    expect(refreshCatalog).toHaveBeenCalledTimes(2);

    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1_000);
    expect(checkApplication).toHaveBeenCalledTimes(2);
    expect(refreshCatalog).toHaveBeenCalledTimes(2);
  });

  it('keeps catalog checks running when application checks are disabled and resumes them promptly', async () => {
    vi.useFakeTimers();
    const checkApplication = vi.fn(async () => undefined);
    const refreshCatalog = vi.fn(async () => undefined);
    const scheduler = new BackgroundUpdateScheduler({
      checkApplication, refreshCatalog, applicationChecksEnabled: false,
      initialDelayMs: 100, intervalMs: 1_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(refreshCatalog).toHaveBeenCalledOnce();
    expect(checkApplication).not.toHaveBeenCalled();
    await checkApplication();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshCatalog).toHaveBeenCalledTimes(2);
    expect(checkApplication).toHaveBeenCalledOnce();

    scheduler.setApplicationChecksEnabled(true);
    scheduler.setApplicationChecksEnabled(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(checkApplication).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(checkApplication).toHaveBeenCalledTimes(2);
    expect(refreshCatalog).toHaveBeenCalledTimes(3);
    scheduler.setApplicationChecksEnabled(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(checkApplication).toHaveBeenCalledTimes(2);
    expect(refreshCatalog).toHaveBeenCalledTimes(4);
    scheduler.dispose();
  });

  it('waits for both checks before rescheduling and isolates failures', async () => {
    vi.useFakeTimers();
    const pendingCatalog = Promise.withResolvers<void>();
    const checkApplication = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined);
    const refreshCatalog = vi.fn().mockImplementationOnce(() => pendingCatalog.promise).mockResolvedValue(undefined);
    const scheduler = new BackgroundUpdateScheduler({
      checkApplication, refreshCatalog, applicationChecksEnabled: true,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkApplication).toHaveBeenCalledOnce();
    expect(refreshCatalog).toHaveBeenCalledOnce();
    scheduler.setApplicationChecksEnabled(false);
    scheduler.setApplicationChecksEnabled(true);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
    expect(refreshCatalog).toHaveBeenCalledOnce();
    pendingCatalog.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkApplication).toHaveBeenCalledTimes(2);
    expect(refreshCatalog).toHaveBeenCalledTimes(2);

    scheduler.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not postpone an imminent catalog check when application checks are enabled', async () => {
    vi.useFakeTimers();
    const checkApplication = vi.fn(async () => undefined);
    const refreshCatalog = vi.fn(async () => undefined);
    const scheduler = new BackgroundUpdateScheduler({
      checkApplication, refreshCatalog, applicationChecksEnabled: false,
      initialDelayMs: 100, intervalMs: 1_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_050);
    expect(refreshCatalog).toHaveBeenCalledOnce();
    scheduler.setApplicationChecksEnabled(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(checkApplication).toHaveBeenCalledOnce();
    expect(refreshCatalog).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
});
