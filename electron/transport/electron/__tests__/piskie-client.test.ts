import { describe, expect, it, vi } from 'vitest';

import { OBSERVABILITY_TOPICS } from '../../../../shared/electron-contracts/observability.js';
import { ACCOUNT_OPERATIONS } from '../../../../shared/electron-contracts/account.js';
import { DESKTOP_OPERATIONS } from '../../../../shared/electron-contracts/desktop.js';
import { PILOT_OPERATIONS } from '../../../../shared/electron-contracts/pilot.js';
import { INFERENCE_OPERATIONS } from '../../../../shared/electron-contracts/inference.js';
import {
  UPDATE_OPERATIONS,
  UPDATE_TOPICS,
} from '../../../../shared/electron-contracts/updates.js';
import { createElectronPiskieClient } from '../piskie-client.js';
import type { ElectronPreloadClient } from '../preload-client.js';

describe('createElectronPiskieClient', () => {
  it('queries effective composer Skills for the requested workspace', async () => {
    const options = [{ name: 'sample-guide', description: 'Sample guide', scope: 'project' }];
    const request = vi.fn(async () => options);
    const client = createElectronPiskieClient({
      transport: { request, subscribe: vi.fn() } as unknown as ElectronPreloadClient,
      version: 'test', platform: 'linux',
    });
    await expect(client.capabilities.market.availableSkills('/sample/project')).resolves.toEqual(options);
    expect(request).toHaveBeenLastCalledWith('capabilities.market.availableSkills', ['/sample/project']);
    await client.capabilities.market.availableSkills();
    expect(request).toHaveBeenLastCalledWith('capabilities.market.availableSkills', [undefined]);
  });

  it('forwards an explicit official model catalog refresh', async () => {
    const request = vi.fn(async () => ({ updated: true }));
    const client = createElectronPiskieClient({
      transport: { request, subscribe: vi.fn() } as unknown as ElectronPreloadClient,
      version: 'test',
      platform: 'linux',
    });

    await expect(client.inference.refreshCatalog()).resolves.toEqual({ updated: true });
    expect(request).toHaveBeenCalledWith(INFERENCE_OPERATIONS.refreshCatalog, []);
  });

  it('keeps the account wait open while bounding regular account requests', async () => {
    const request = vi.fn(async () => ({ state: 'signed-out' }));
    const transport = {
      request,
      subscribe: vi.fn(),
    } as unknown as ElectronPreloadClient;
    const client = createElectronPiskieClient({
      transport,
      version: 'test',
      platform: 'linux',
    });

    await client.account.status();
    await client.account.waitForSignIn('flow-1');

    expect(request.mock.calls).toEqual([
      [ACCOUNT_OPERATIONS.status, [], { timeoutMs: 60_000 }],
      [ACCOUNT_OPERATIONS.waitForSignIn, ['flow-1'], { timeoutMs: 0 }],
    ]);
  });

  it('forwards explicit attachment sources and preview release without rereading clipboard data', async () => {
    const request = vi.fn(async () => undefined);
    const client = createElectronPiskieClient({ transport: { request, subscribe: vi.fn() } as unknown as ElectronPreloadClient, version: 'test', platform: 'linux' });
    const sources = { kind: 'paths' as const, paths: ['/workspace/example.png'] };
    await client.desktop.system.clipboardAttachments(sources);
    await client.desktop.files.releasePreview('piskie-attachment://preview/example');
    expect(request.mock.calls).toEqual([
      [DESKTOP_OPERATIONS.clipboardAttachments, [sources]],
      [DESKTOP_OPERATIONS.releasePreview, ['piskie-attachment://preview/example']],
    ]);
  });

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

  it('allows slow update checks and forwards both update snapshots and changes', async () => {
    const unsubscribe = vi.fn();
    const request = vi.fn(async () => ({ state: 'idle', currentVersion: '0.1.0' }));
    const subscribe = vi.fn(() => unsubscribe);
    const transport = {
      request,
      subscribe,
    } as unknown as ElectronPreloadClient;
    const client = createElectronPiskieClient({
      transport,
      version: '0.1.0',
      platform: 'linux',
    });
    const listener = vi.fn();

    await client.updates.check();
    const dispose = client.updates.observeStatus(listener);

    expect(request).toHaveBeenCalledWith(
      UPDATE_OPERATIONS.check,
      [],
      { timeoutMs: 120_000 },
    );
    expect(subscribe).toHaveBeenCalledWith(UPDATE_TOPICS.status, {
      onSnapshot: listener,
      onChange: listener,
    });
    expect(dispose).toBe(unsubscribe);
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

    const target = { agentId: 'session-alpha', workerId: 'worker-one' };
    await client.pilot.embeddedBrowser.openLocalHtml(target, '/tmp/example.html');

    expect(request).toHaveBeenCalledWith(
      PILOT_OPERATIONS.openLocalHtmlInEmbeddedBrowser,
      [target, '/tmp/example.html'],
    );
  });

  it('subscribes to preview snapshots and changes for an explicit target', () => {
    const subscribe = vi.fn(() => vi.fn());
    const client = createElectronPiskieClient({
      transport: { subscribe } as unknown as ElectronPreloadClient,
      version: 'test', platform: 'linux',
    });
    const target = { agentId: 'session-alpha', workerId: 'worker-one' };
    const listener = vi.fn();
    client.pilot.embeddedBrowser.observeState(target, listener);
    expect(subscribe).toHaveBeenCalledWith('pilot.embeddedBrowser.state', {
      payload: target, onSnapshot: listener, onChange: listener,
    });
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
