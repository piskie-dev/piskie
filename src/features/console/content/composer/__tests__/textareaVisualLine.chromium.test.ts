import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const chromiumPath = process.env.FP_CHROMIUM_PATH;
const canRun = Boolean(chromiumPath && existsSync(chromiumPath));
const VALUE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz';

describe.skipIf(!canRun)('textareaVisualLine in Chromium', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('../textareaVisualLine.ts', import.meta.url))],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'ComposerVisualLine',
      platform: 'browser',
      target: 'chrome120',
    });
    browser = await puppeteer.launch({
      executablePath: chromiumPath!,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
      <textarea spellcheck="false"></textarea>
      <style>
        textarea {
          box-sizing: border-box;
          width: 140px;
          height: 180px;
          overflow: hidden;
          resize: none;
          border: 1px solid #555;
          padding: 4px;
          font-family: "Courier New", monospace;
          font-size: 16px;
          line-height: 20px;
          letter-spacing: 0;
          tab-size: 4;
          white-space: pre-wrap;
          overflow-wrap: break-word;
        }
      </style>
    </body></html>`);
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.$eval('textarea', (textarea, value) => { textarea.value = value; }, VALUE);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('matches Chromium visual rows at interiors and exact soft-wrap boundaries', async () => {
    const positions = [5, 12, 13, 44, 77, 78, 83];
    const actual = await page.$eval('textarea', (textarea, caretPositions) => {
      const api = (window as unknown as {
        ComposerVisualLine: { textareaVisualLine: (element: HTMLTextAreaElement) => { first: boolean; last: boolean } };
      }).ComposerVisualLine;
      return caretPositions.map((position) => {
        textarea.setSelectionRange(position, position);
        return api.textareaVisualLine(textarea);
      });
    }, positions);

    expect(actual).toEqual([
      { first: true, last: false },
      { first: true, last: false },
      { first: false, last: false },
      { first: false, last: false },
      { first: false, last: false },
      { first: false, last: true },
      { first: false, last: true },
    ]);
  });

  it('allows native ArrowUp within a wrapped draft and intercepts it on the first visual row', async () => {
    await page.$eval('textarea', (textarea, value) => {
      textarea.value = value;
      textarea.dataset.recalled = '';
      const api = (window as unknown as {
        ComposerVisualLine: { textareaVisualLine: (element: HTMLTextAreaElement) => { first: boolean } };
      }).ComposerVisualLine;
      textarea.onkeydown = (event) => {
        if (event.key !== 'ArrowUp' || !api.textareaVisualLine(textarea).first) return;
        event.preventDefault();
        textarea.dataset.recalled = 'true';
      };
      textarea.focus();
      textarea.setSelectionRange(44, 44);
    }, VALUE);
    await page.keyboard.press('ArrowUp');
    expect(await page.$eval('textarea', (textarea) => ({
      recalled: textarea.dataset.recalled,
      selectionStart: textarea.selectionStart,
    }))).toEqual({ recalled: '', selectionStart: 31 });

    await page.$eval('textarea', (textarea) => textarea.setSelectionRange(5, 5));
    await page.keyboard.press('ArrowUp');
    expect(await page.$eval('textarea', (textarea) => ({
      recalled: textarea.dataset.recalled,
      selectionStart: textarea.selectionStart,
    }))).toEqual({ recalled: 'true', selectionStart: 5 });
  });
});
