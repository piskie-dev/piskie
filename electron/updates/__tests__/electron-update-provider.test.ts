import type { AppUpdater } from 'electron-updater';
import { describe, expect, it, vi } from 'vitest';

import { createElectronUpdateProvider } from '../electron-update-provider.js';

describe('createElectronUpdateProvider', () => {
  it('downloads automatically without installing on a normal application quit', () => {
    const updater = {
      on: vi.fn(),
      removeListener: vi.fn(),
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
    } as unknown as AppUpdater;

    createElectronUpdateProvider(updater);

    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });
});
