import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';
import { BrowserManager } from '../browser-manager.js';
import { ScreenStreamHub, type ViewerSink } from '../../../screen-hub.js';
import type { StreamServerMessage } from '@shared/types/stream.js';

vi.mock('electron', () => ({ app: { getPath: () => process.env.PISKIE_TEST_ARTIFACT_DIR, getAppPath: () => process.env.PISKIE_TEST_ARTIFACT_DIR } }));
vi.mock('../window-controller.js', () => ({ WindowController: { initialize: async () => {} } }));

describe.skipIf(!process.env.FP_CHROMIUM_PATH)('real Chromium empty-page display lifecycle', () => {
  it('stops real screencast frames after the only page closes and resumes a newly selected page', async () => {
    const root = await mkdtemp(join(process.env.PISKIE_TEST_ARTIFACT_DIR ?? tmpdir(), 'sample-empty-display-'));
    const browser = await puppeteer.launch({ executablePath: process.env.FP_CHROMIUM_PATH, headless: true,
      userDataDir: join(root, 'sample-profile'), args: ['--no-sandbox', '--disable-background-networking'] });
    const pid = browser.process()!.pid!;
    const manager = BrowserManager as unknown as { initialized: boolean; readPersistedBrowserConfig(id: string): Promise<unknown>; savePersisted(id: string, value: unknown): Promise<void>; deletePersisted(id: string): Promise<void> };
    manager.initialized = true;
    vi.spyOn(manager, 'readPersistedBrowserConfig').mockResolvedValue({ wsEndpoint: browser.wsEndpoint() });
    vi.spyOn(manager, 'savePersisted').mockResolvedValue(undefined); vi.spyOn(manager, 'deletePersisted').mockResolvedValue(undefined);
    const browserId = 'sample-empty-display';
    const hub = new ScreenStreamHub(); const messages: StreamServerMessage[] = [];
    const sink: ViewerSink = { isOpen: () => true, send: message => { messages.push(message); } };
    try {
      const session = await BrowserManager.getScreenSession(browserId);
      const page = session.getSelectedPage(); await page.setViewport({ width: 640, height: 480 });
      await page.setContent('<!doctype html><title>Sample display page</title><button>Sample display button</button>');
      await hub.addViewer(browserId, sink);
      await vi.waitFor(() => expect(messages.filter(message => message.type === 'frame').length).toBeGreaterThan(0));
      const before = session.getScreenTarget()!.identity; await page.close();
      await vi.waitFor(() => expect(session.getScreenTarget()).toBeNull());
      expect(await session.listPages()).toEqual([]);
      await new Promise(resolve => setTimeout(resolve, 100));
      const stopped = messages.filter(message => message.type === 'frame').length;
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(messages.filter(message => message.type === 'frame').length).toBe(stopped);
      const next = await session.newPage('about:blank'); await next.setContent('<!doctype html><title>Sample resumed page</title><input aria-label="Sample resumed input">');
      const after = session.getScreenTarget()!.identity;
      expect(after.pageId).not.toBe(before.pageId);
      await vi.waitFor(() => expect(messages.some(message => message.type === 'frame' && message.meta.page?.pageId === after.pageId)).toBe(true), { timeout: 5000 });
      await writeFile(join(root, 'empty-display-evidence.json'), JSON.stringify({ before, after, stoppedFrameCount: stopped,
        frames: messages.filter(message => message.type === 'frame').map(({ data: _data, ...metadata }) => metadata) }, null, 2));
    } finally {
      await writeFile(join(root, 'empty-display-stream.json'), JSON.stringify(messages.map(message => message.type === 'frame' ? { type: message.type, meta: message.meta } : message), null, 2));
      hub.removeViewer(browserId, sink); hub.close(); await BrowserManager.closeAll(); await browser.close();
      expect(() => process.kill(pid, 0)).toThrow(); expect(BrowserManager.ownedIds()).toEqual([]); vi.restoreAllMocks();
    }
  }, 15_000);
});
