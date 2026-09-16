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
  vi.restoreAllMocks();
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

  it.each(['html', 'HTM'])('opens a complete home-relative .%s path with spaces, Unicode, and a directory symlink', async (extension) => {
    vi.spyOn(os, 'homedir').mockReturnValue(testDirectory);
    const directory = path.join(testDirectory, 'sample folder');
    await fs.promises.mkdir(directory);
    const name = `示例 preview.${extension}`;
    const file = path.join(directory, name);
    await fs.promises.writeFile(file, '<!doctype html><title>Sample</title>');
    await fs.promises.symlink(directory, path.join(testDirectory, 'linked folder'), 'junction');
    const { application, embeddedBrowser, open, openLocalHtml } = fixture();

    await application.openLocalHtmlInEmbeddedBrowser(42, owner, `~/linked folder/${name}`);

    expect(embeddedBrowser).toHaveBeenCalledWith(42);
    expect(open).toHaveBeenCalledWith(owner);
    expect(openLocalHtml).toHaveBeenCalledExactlyOnceWith(await fs.promises.realpath(file));
  });

  it('retains existence, regular-file, and HTML checks for home-relative paths', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(testDirectory);
    await fs.promises.mkdir(path.join(testDirectory, 'sample.html'));
    await fs.promises.writeFile(path.join(testDirectory, 'sample.txt'), 'Sample contents');
    const { application, openLocalHtml } = fixture();

    await expect(application.openLocalHtmlInEmbeddedBrowser(1, owner, '~/missing.html'))
      .rejects.toMatchObject({ code: 'not-found' });
    for (const target of ['~', '~/', '~/sample.html']) {
      await expect(application.openLocalHtmlInEmbeddedBrowser(1, owner, target))
        .rejects.toMatchObject({ code: 'invalid-input', message: 'A regular file is required' });
    }
    await expect(application.openLocalHtmlInEmbeddedBrowser(1, owner, '~/sample.txt'))
      .rejects.toMatchObject({ code: 'unsupported' });
    expect(openLocalHtml).not.toHaveBeenCalled();
  });

  it.each(['~sample/page.html', '$HOME/page.html'])('rejects unsupported shell path syntax: %s', async (target) => {
    const { application, open, openLocalHtml } = fixture();

    await expect(application.openLocalHtmlInEmbeddedBrowser(1, owner, target))
      .rejects.toMatchObject({ code: 'invalid-input', message: 'An absolute path is required' });
    expect(open).not.toHaveBeenCalled();
    expect(openLocalHtml).not.toHaveBeenCalled();
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
