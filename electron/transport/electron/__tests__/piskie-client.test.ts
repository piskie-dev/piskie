import { describe, expect, it, vi } from 'vitest';

import { OBSERVABILITY_TOPICS } from '../../../../shared/electron-contracts/observability.js';
import { DESKTOP_OPERATIONS } from '../../../../shared/electron-contracts/desktop.js';
import { PILOT_OPERATIONS } from '../../../../shared/electron-contracts/pilot.js';
import { createElectronPiskieClient } from '../piskie-client.js';
import type { ElectronPreloadClient } from '../preload-client.js';

describe('createElectronPiskieClient', () => {
  it('forwards the effective renderer color scheme to the desktop host', async () => {
    const request = vi.fn(async () => undefined);
    const transport = {
      request,
      subscribe: vi.fn(),
    } as unknown as ElectronPreloadClient;
    const client = createElectronPiskieClient({
      transport,
      version: 'test',
      platform: 'linux',
    });

    await client.desktop.theme.setColorScheme('dark');

    expect(request).toHaveBeenCalledWith(DESKTOP_OPERATIONS.setColorScheme, ['dark']);
  });

  it('forwards local HTML previews to the embedded browser operation', async () => {
    const request = vi.fn(async () => undefined);
    const transport = {
      request,
      subscribe: vi.fn(),
    } as unknown as ElectronPreloadClient;
    const client = createElectronPiskieClient({
      transport,
      version: 'test',
      platform: 'linux',
    });

    await client.pilot.embeddedBrowser.openLocalHtml('/tmp/example.html');

    expect(request).toHaveBeenCalledWith(
      PILOT_OPERATIONS.openLocalHtmlInEmbeddedBrowser,
      ['/tmp/example.html'],
    );
  });

  it('does not impose a transport deadline on file and workspace selection', async () => {
    const request = vi.fn(async () => undefined);
    const transport = {
      request,
      subscribe: vi.fn(),
    } as unknown as ElectronPreloadClient;
    const client = createElectronPiskieClient({
      transport,
      version: 'test',
      platform: 'win32',
    });

    await client.desktop.files.select({ type: 'folder' });
    await client.desktop.files.select({ type: 'file' });

    expect(request.mock.calls).toEqual([
      [DESKTOP_OPERATIONS.selectFiles, [{ type: 'folder' }], { timeoutMs: 0 }],
      [DESKTOP_OPERATIONS.selectFiles, [{ type: 'file' }], { timeoutMs: 0 }],
    ]);
  });

  it('forwards both Agent incident snapshot and change handlers to the transport', () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const transport = {
      request: vi.fn(),
      subscribe,
    } as unknown as ElectronPreloadClient;
    const client = createElectronPiskieClient({
      transport,
      version: 'test',
      platform: 'linux',
    });
    const observer = {
      onSnapshot: vi.fn(),
      onChange: vi.fn(),
    };

    const dispose = client.observability.incidents.observe(observer);

    expect(subscribe).toHaveBeenCalledWith(OBSERVABILITY_TOPICS.incidents, observer);
    expect(dispose).toBe(unsubscribe);
  });
});
