import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PilotApplication } from '../pilot-application.js';

let testDirectory: string;
const owner = { agentId: 'session-alpha', workerId: 'worker-one' };

beforeEach(async () => {
  testDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piskie-local-html-'));
});

afterEach(async () => {
  await fs.promises.rm(testDirectory, { recursive: true, force: true });
});

function fixture() {
  const openLocalHtml = vi.fn(async () => undefined);
  const open = vi.fn(() => ({ openLocalHtml }));
  const embeddedBrowser = vi.fn(() => ({ open }));
  const application = new PilotApplication({
    config: {} as never,
    environments: {} as never,
    screens: {} as never,
    streams: {} as never,
    browser: {} as never,
    presentation: { embeddedBrowser } as never,
  });
  return { application, embeddedBrowser, open, openLocalHtml };
}

describe('PilotApplication local HTML preview', () => {
  it('opens an existing HTML file through the caller window presentation', async () => {
    const target = path.join(testDirectory, 'Example.HTM');
    await fs.promises.writeFile(target, '<!doctype html><title>Example</title>');
    const { application, embeddedBrowser, open, openLocalHtml } = fixture();

    await application.openLocalHtmlInEmbeddedBrowser(42, owner, target);

    expect(embeddedBrowser).toHaveBeenCalledWith(42);
    expect(open).toHaveBeenCalledWith(owner);
    expect(openLocalHtml).toHaveBeenCalledWith(await fs.promises.realpath(target));
  });

  it('rejects relative paths, missing files, directories, and non-HTML files', async () => {
    const textFile = path.join(testDirectory, 'notes.txt');
    await fs.promises.writeFile(textFile, 'notes');
    const { application, openLocalHtml } = fixture();

    await expect(application.openLocalHtmlInEmbeddedBrowser(1, owner, 'page.html')).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(
      application.openLocalHtmlInEmbeddedBrowser(1, owner, path.join(testDirectory, 'missing.html')),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(application.openLocalHtmlInEmbeddedBrowser(1, owner, testDirectory)).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(application.openLocalHtmlInEmbeddedBrowser(1, owner, textFile)).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(openLocalHtml).not.toHaveBeenCalled();
  });
});
