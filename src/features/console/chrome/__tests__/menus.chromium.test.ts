import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const chromiumPath = process.env.FP_CHROMIUM_PATH;
const canRun = Boolean(chromiumPath && existsSync(chromiumPath));

interface MenuTestState {
  selected: [string, string][];
  clicked: string[];
  remote: number;
  render: (options?: { items?: { key: string; label: string }[] }) => void;
}

declare global {
  interface Window {
    menuTest: MenuTestState;
  }
}

describe.skipIf(!canRun)('shared menus in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let script: string;
  let css: string;

  beforeAll(async () => {
    const bundle = await build({
      stdin: {
        contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { MenuHarness } from './menuHarness';
          import { mountShortcutListener } from '@/shortcuts';
          const root = createRoot(document.getElementById('root'));
          const state = window.menuTest = {
            selected: [], clicked: [], remote: 0,
            render: (options = {}) => root.render(<MenuHarness {...options}
              onSelect={(id, key) => state.selected.push([id, key])}
              onObjectClick={(id) => state.clicked.push(id)}
              onRemoteContextMenu={() => state.remote++} />),
          };
          mountShortcutListener(window);
          state.render();
        `,
        loader: 'tsx',
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      },
      bundle: true,
      write: false,
      outdir: tmpdir(),
      format: 'iife',
      platform: 'browser',
      target: 'chrome148',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    script = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    css += await readFile(new URL('../../../../styles/tokens.css', import.meta.url), 'utf8');
    browser = await puppeteer.launch({
      executablePath: chromiumPath!,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 640, height: 480 });
  }, 30_000);

  beforeEach(async () => {
    await page.setViewport({ width: 640, height: 480 });
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
    await page.addStyleTag({ content: `${css}
      body { margin: 8px; }
      #gamma { margin-left: 370px; }
      [popover] { transition: none !important; translate: none !important; }
    ` });
    await page.addScriptTag({ content: script });
    await page.waitForSelector('#alpha-label');
  });

  afterAll(async () => { await browser?.close(); });

  async function openAt(x = 80, y = 60, selector = '#alpha-label') {
    await page.$eval(selector, (target, point) => target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, clientX: point.x, clientY: point.y,
    })), { x, y });
    await page.waitForSelector('[popover]:popover-open [role="menu"]');
  }

  async function openMenus() {
    return page.$$eval('[popover]:popover-open > [role="menu"]', (menus) => (
      menus.map((menu) => menu.getAttribute('aria-label'))
    ));
  }

  async function choose(label: string) {
    const button = await page.waitForSelector(`::-p-aria(${label})`);
    await button!.click();
  }

  async function rectangles() {
    return page.$$eval('[popover]:popover-open', (popovers) => popovers.map((popover) => {
      const { left, top, right, bottom } = popover.getBoundingClientRect();
      return { left, top, right, bottom };
    }));
  }

  it('runs the same actions from the mouse and button, and preserves button toggling', async () => {
    await page.click('#alpha-label', { button: 'right' });
    await choose('Open object');
    await page.click('button[aria-label="alpha actions"]');
    await choose('Open object');
    expect(await page.evaluate(() => window.menuTest.selected)).toEqual([['alpha', 'open'], ['alpha', 'open']]);
    expect(await page.evaluate(() => window.menuTest.clicked)).toEqual([]);
    await page.click('button[aria-label="alpha actions"]');
    expect(await openMenus()).toEqual(['alpha actions']);
    await page.click('button[aria-label="alpha actions"]');
    expect(await openMenus()).toEqual([]);
  });

  it('replaces an open menu with another object and honors the nearest nested target', async () => {
    await page.click('button[aria-label="alpha actions"]');
    await page.click('#gamma-label', { button: 'right' });
    expect(await openMenus()).toEqual(['gamma actions']);
    await openAt(300, 100, '#beta-child');
    expect(await openMenus()).toEqual(['beta actions']);
    await choose('Open object');
    expect(await page.evaluate(() => window.menuTest.selected)).toEqual([['beta', 'open']]);
    expect(await page.evaluate(() => window.menuTest.clicked)).toEqual([]);
  });

  it('anchors at the pointer and keeps all four viewport corners inside the window', async () => {
    await openAt(80, 60);
    expect((await rectangles())[0]).toMatchObject({ left: 80, top: 60 });
    for (const [x, y] of [[1, 1], [639, 1], [639, 479], [1, 479]]) {
      await openAt(x, y);
      const rect = (await rectangles())[0]!;
      expect(rect.left).toBeGreaterThanOrEqual(8);
      expect(rect.top).toBeGreaterThanOrEqual(8);
      expect(rect.right).toBeLessThanOrEqual(632);
      expect(rect.bottom).toBeLessThanOrEqual(472);
    }
    await page.setViewport({ width: 360, height: 260 });
    await page.waitForFunction(() => document.querySelector('[popover]:popover-open')!.getBoundingClientRect().bottom <= 252);
    const rect = (await rectangles())[0]!;
    expect(rect.right).toBeLessThanOrEqual(352);
    expect(rect.bottom).toBeLessThanOrEqual(252);
    await page.setViewport({ width: 640, height: 480 });
  });

  it('scrolls long menus without closing them and can select the last action', async () => {
    await page.evaluate(() => window.menuTest.render({ items: Array.from({ length: 90 }, (_, index) => ({
      key: `action-${index}`, label: `Example action ${index}`,
    })) }));
    await openAt(630, 470);
    const rect = (await rectangles())[0]!;
    expect(rect.top).toBeGreaterThanOrEqual(8);
    expect(rect.bottom).toBeLessThanOrEqual(472);
    const scrolling = await page.$eval('[role="menu"]', (menu) => {
      const element = menu as HTMLElement;
      element.scrollTop = element.scrollHeight;
      return { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
    });
    expect(scrolling.scrollHeight).toBeGreaterThan(scrolling.clientHeight);
    expect(await openMenus()).toEqual(['alpha actions']);
    await choose('Example action 89');
    expect(await page.evaluate(() => window.menuTest.selected)).toEqual([['alpha', 'action-89']]);
  });

  it('keeps sorting submenus in bounds and dispatches only their selected leaf', async () => {
    await openAt(630, 470);
    await choose('Sort objects');
    expect(await openMenus()).toEqual(['alpha actions', 'Sort objects']);
    for (const rect of await rectangles()) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(640);
      expect(rect.bottom).toBeLessThanOrEqual(480);
    }
    expect(await page.evaluate(() => window.menuTest.selected)).toEqual([]);
    await choose('By recent activity');
    expect(await page.evaluate(() => window.menuTest.selected)).toEqual([['alpha', 'recent']]);
    expect(await openMenus()).toEqual([]);
  });

  it('closes on outside click, target scroll, dragging and the existing Escape dismissal', async () => {
    await openAt();
    await page.click('#outside');
    expect(await openMenus()).toEqual([]);
    await openAt();
    await page.$eval('#other-scroller', (element) => { element.scrollTop = 40; });
    expect(await openMenus()).toEqual(['alpha actions']);
    await page.$eval('#scroller', (element) => { element.scrollTop = 40; });
    await page.waitForFunction(() => document.querySelector('[popover]:popover-open') === null);
    await openAt();
    await page.$eval('#alpha', (element) => element.dispatchEvent(new DragEvent('dragstart', { bubbles: true })));
    expect(await openMenus()).toEqual([]);
    await openAt();
    await page.keyboard.press('Escape');
    expect(await openMenus()).toEqual([]);
  });

  it('keeps native selected-text/editing menus and unregistered remote handling available', async () => {
    const result = await page.evaluate(() => {
      const selected = document.querySelector('#body-selection')!;
      const range = document.createRange();
      range.selectNodeContents(selected);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const prevented = ['#editor', '#draft', '#editable-title', '#body-selection', '#unregistered'].map((selector) => {
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
        document.querySelector(selector)!.dispatchEvent(event);
        return event.defaultPrevented;
      });
      document.querySelector('#remote')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
      return { prevented, selection: selection.toString(), remote: window.menuTest.remote };
    });
    expect(result).toEqual({ prevented: [false, false, false, false, false], selection: 'Selectable example text', remote: 1 });
    expect(await openMenus()).toEqual([]);
  });
});
