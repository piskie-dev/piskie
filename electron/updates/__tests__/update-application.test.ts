import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpdateApplication, classifyUpdateError } from '../update-application.js';
import type { UpdateProvider, UpdateProviderEvent } from '../update-provider.js';

class FakeUpdateProvider implements UpdateProvider {
  readonly checkForUpdates = vi.fn(async (): Promise<void> => undefined);
  readonly quitAndInstall = vi.fn();
  private listener?: (event: UpdateProviderEvent) => void;

  subscribe(listener: (event: UpdateProviderEvent) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  emit(event: UpdateProviderEvent): void {
    this.listener?.(event);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('UpdateApplication', () => {
  it('keeps development and unpackaged clients inert', async () => {
    const application = new UpdateApplication({
      currentVersion: '0.1.0',
      disabledReason: 'development',
    });

    application.start();

    await expect(application.check()).resolves.toEqual({
      state: 'disabled',
      reason: 'development',
      currentVersion: '0.1.0',
    });
    expect(application.restartAndInstall()).toBe(false);
  });

  it('treats a missing first GitHub release as a non-fatal, retryable status', async () => {
    const provider = new FakeUpdateProvider();
    provider.checkForUpdates.mockRejectedValueOnce(
      new Error('HttpError: 404 latest.yml was not found'),
    );
    const application = new UpdateApplication({
      currentVersion: '0.1.0',
      provider,
      initialDelayMs: 60_000,
      now: () => Date.parse('2026-09-03T08:00:00.000Z'),
    });
    application.start();

    await expect(application.check()).resolves.toEqual({
      state: 'error',
      error: 'no-release',
      currentVersion: '0.1.0',
      checkedAt: '2026-09-03T08:00:00.000Z',
      retryable: true,
    });
    application.dispose();
  });

  it('publishes download progress and installs only after the update is ready', () => {
    const provider = new FakeUpdateProvider();
    const application = new UpdateApplication({
      currentVersion: '0.1.0',
      provider,
      initialDelayMs: 60_000,
    });
    const observed: unknown[] = [];
    application.changes.subscribe((status) => observed.push(status));
    application.start();

    provider.emit({
      type: 'available',
      release: { version: '0.1.1' },
    });
    expect(application.restartAndInstall()).toBe(false);
    provider.emit({
      type: 'progress',
      progress: {
        percent: 41.6,
      },
    });
    provider.emit({ type: 'downloaded', release: { version: '0.1.1' } });

    expect(observed).toContainEqual(expect.objectContaining({
      state: 'downloading',
      target: { version: '0.1.1' },
      percent: 41.6,
    }));
    expect(application.status()).toEqual({
      state: 'downloaded',
      currentVersion: '0.1.0',
      target: { version: '0.1.1' },
    });
    expect(application.restartAndInstall()).toBe(true);
    expect(provider.quitAndInstall).toHaveBeenCalledOnce();
    application.dispose();
  });

  it('checks after the startup delay and then on the six-hour cadence', async () => {
    vi.useFakeTimers();
    const provider = new FakeUpdateProvider();
    provider.checkForUpdates.mockImplementation(async () => {
      provider.emit({ type: 'not-available' });
    });
    const application = new UpdateApplication({
      currentVersion: '0.1.0',
      provider,
    });

    application.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(provider.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000);
    expect(provider.checkForUpdates).toHaveBeenCalledTimes(2);
    application.dispose();
  });
});

describe('classifyUpdateError', () => {
  it('keeps public error categories bounded', () => {
    expect(classifyUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toBe('network');
    expect(classifyUpdateError(new Error('No published versions on GitHub'))).toBe('no-release');
    expect(classifyUpdateError(new Error('signature mismatch'))).toBe('generic');
  });
});
