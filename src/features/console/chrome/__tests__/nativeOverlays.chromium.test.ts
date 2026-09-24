import { existsSync } from 'node:fs';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const chromiumPath = process.env.FP_CHROMIUM_PATH;
const canRun = Boolean(chromiumPath && existsSync(chromiumPath));

interface NativeOverlaySnapshot {
  readonly dialogOpen: boolean;
  readonly popoverOpen: boolean;
  readonly events: readonly string[];
}

describe.skipIf(!canRun)('managed native overlay Escape order in Chromium', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: chromiumPath!,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <html><body>
        <dialog id="dialog" closedby="any">
          <button id="trigger" popovertarget="popover">Open</button>
          <div id="popover" popover="auto"><button autofocus>Nested action</button></div>
        </dialog>
        <script>
          window.overlayEvents = [];
          const dialog = document.querySelector('#dialog');
          const popover = document.querySelector('#popover');
          window.addEventListener('keydown', (event) => {
            window.overlayEvents.push('keydown:' + event.key);
            if (event.key === 'Escape' && popover.matches(':popover-open')) {
              event.preventDefault();
              window.overlayEvents.push('popover:dismiss');
              popover.hidePopover();
            }
          });
          dialog.addEventListener('cancel', () => window.overlayEvents.push('dialog:cancel'));
          dialog.addEventListener('close', () => window.overlayEvents.push('dialog:close'));
          popover.addEventListener('toggle', (event) => {
            window.overlayEvents.push('popover:' + event.newState);
          });
          dialog.showModal();
          popover.showPopover();
        </script>
      </body></html>`);
    await page.waitForFunction(() => document.querySelector('#popover')?.matches(':popover-open'));
    await page.evaluate(() => {
      (window as unknown as { overlayEvents: string[] }).overlayEvents = [];
    });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function snapshot(): Promise<NativeOverlaySnapshot> {
    return page.evaluate(() => ({
      dialogOpen: (document.querySelector('#dialog') as HTMLDialogElement).open,
      popoverOpen: document.querySelector('#popover')!.matches(':popover-open'),
      events: [...(window as unknown as { overlayEvents: string[] }).overlayEvents],
    }));
  }

  it('prevents the first default dismissal for the Popover, then delegates to the Dialog', async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
      (window as unknown as { overlayEvents: string[] }).overlayEvents.includes('popover:closed')
    ));
    const afterPopover = await snapshot();
    expect(afterPopover.dialogOpen).toBe(true);
    expect(afterPopover.popoverOpen).toBe(false);
    expect(afterPopover.events.indexOf('keydown:Escape'))
      .toBeLessThan(afterPopover.events.indexOf('popover:dismiss'));
    expect(afterPopover.events.indexOf('popover:dismiss'))
      .toBeLessThan(afterPopover.events.indexOf('popover:closed'));
    expect(afterPopover.events).not.toContain('dialog:cancel');

    await page.evaluate(() => {
      (window as unknown as { overlayEvents: string[] }).overlayEvents = [];
    });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
      (window as unknown as { overlayEvents: string[] }).overlayEvents.includes('dialog:close')
    ));
    const afterDialog = await snapshot();
    expect(afterDialog.events).toEqual([
      'keydown:Escape',
      'dialog:cancel',
      'dialog:close',
    ]);
  });
});
