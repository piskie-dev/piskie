import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser, Dialog, Page } from 'puppeteer-core';
import { ActionWaiter } from '../action-waiter.js';
import { BrowserAutomationSession, BrowserDialogOpenError } from '../browser-automation-session.js';
import { PageRegistry } from '../page-registry.js';
import { formatTextSnapshot, resetSnapshotIdsForTesting } from '../text-snapshot.js';

function fakePage(url: string) {
  const events = new EventEmitter();
  const client = new EventEmitter();
  let currentUrl = url;
  const frame = {};
  const locator = {
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    hover: vi.fn(async () => undefined),
  };
  const handle = {
    dispose: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => false),
    asLocator: vi.fn(() => locator),
    drag: vi.fn(async () => undefined),
    drop: vi.fn(async () => undefined),
    uploadFile: vi.fn(async () => undefined),
  };
  const root = {
    role: 'button',
    name: 'Continue',
    value: 'ready',
    children: [],
    elementHandle: vi.fn(async () => handle),
  };
  const target = {};
  const stableDomHandle = {
    evaluate: vi.fn(async () => true),
    dispose: vi.fn(async () => undefined),
  };
  const fileChooser = { accept: vi.fn(async () => undefined) };
  const page = Object.assign(events, {
    url: vi.fn(() => currentUrl),
    setUrl(value: string) {
      currentUrl = value;
    },
    target: vi.fn(() => target),
    mainFrame: vi.fn(() => frame),
    isClosed: vi.fn(() => false),
    emulateFocusedPage: vi.fn(async () => undefined),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    getDefaultTimeout: vi.fn(() => 5_000),
    _client: vi.fn(() => client),
    accessibility: { snapshot: vi.fn(async () => root) },
    waitForNavigation: vi.fn(async () => null),
    waitForFileChooser: vi.fn(async () => fileChooser),
    evaluate: vi.fn(async () => true),
    evaluateHandle: vi.fn(async () => stableDomHandle),
    keyboard: {
      down: vi.fn(async () => undefined),
      press: vi.fn(async () => undefined),
      up: vi.fn(async () => undefined),
    },
  }) as unknown as Page & { setUrl(value: string): void };
  return { page, frame, client, fileChooser, handle, locator, root, stableDomHandle };
}

function fakeBrowser(pages: Page[]) {
  const events = new EventEmitter();
  return Object.assign(events, {
    pages: vi.fn(async () => pages),
    newPage: vi.fn(),
  }) as unknown as Browser;
}

function fakeDialog(type: 'alert' | 'beforeunload' | 'confirm' | 'prompt' = 'prompt') {
  let handled = false;
  const dialog = {
    type: vi.fn(() => type),
    message: vi.fn(() => 'Continue?'),
    defaultValue: vi.fn(() => ''),
    get handled() {
      return handled;
    },
    accept: vi.fn(async () => {
      handled = true;
    }),
    dismiss: vi.fn(async () => {
      handled = true;
    }),
  } as unknown as Dialog;
  return dialog;
}

describe('BrowserAutomationSession', () => {
  beforeEach(() => {
    PageRegistry.resetPageIdsForTesting();
    resetSnapshotIdsForTesting();
  });

  afterEach(() => vi.useRealTimers());

  it('keeps one active snapshot and invalidates UIDs on replacement, selection, and navigation', async () => {
    const first = fakePage('https://example.test/first');
    const second = fakePage('https://example.test/second');
    const session = await BrowserAutomationSession.create(fakeBrowser([first.page, second.page]));

    const initial = await session.takeSnapshot();
    await expect(session.getElementByUid(initial.root.id)).resolves.toBe(first.handle);

    const replacement = await session.takeSnapshot();
    await expect(session.getElementByUid(initial.root.id)).rejects.toThrow('stale snapshot');
    await expect(session.getElementByUid(replacement.root.id)).resolves.toBe(first.handle);

    await session.selectPageByIndex(1);
    await expect(session.getElementByUid(replacement.root.id)).rejects.toThrow('No snapshot found');
    const selectedSnapshot = await session.takeSnapshot();
    second.page.emit('framenavigated', second.frame);
    await expect(session.getElementByUid(selectedSnapshot.root.id)).rejects.toThrow('No snapshot found');
    session.dispose();
  });

  it('preserves observable accessibility values in formatted snapshots', async () => {
    const current = fakePage('https://example.test');
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));

    const snapshot = await session.takeSnapshot();
    expect(formatTextSnapshot(snapshot)).toContain('[1_0] button "Continue" = "ready"');
    session.dispose();
  });

  it('captures and explicitly handles per-page dialogs', async () => {
    const current = fakePage('https://example.test');
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const dialog = fakeDialog();
    current.page.emit('dialog', dialog);

    expect(() => session.throwIfDialogOpen()).toThrow(BrowserDialogOpenError);
    await session.handleDialog('accept', 'yes');
    expect(dialog.accept).toHaveBeenCalledWith('yes');
    expect(() => session.throwIfDialogOpen()).not.toThrow();
    session.dispose();
  });

  it('surfaces a dialog raised by a completed click and releases its handle without waiting', async () => {
    const current = fakePage('https://example.test');
    const dialog = fakeDialog();
    current.locator.click.mockImplementation(async () => {
      current.page.emit('dialog', dialog);
    });
    current.handle.dispose.mockImplementation(() => new Promise<never>(() => undefined));
    const browser = fakeBrowser([current.page]);
    const session = await BrowserAutomationSession.create(browser);
    const snapshot = await session.takeSnapshot();

    await expect(session.clickByUid(snapshot.root.id, 1)).rejects.toBeInstanceOf(
      BrowserDialogOpenError
    );
    expect(browser.pages).toHaveBeenCalledTimes(3);
    expect(current.handle.dispose).toHaveBeenCalledOnce();

    await session.handleDialog('accept', 'Grace');
    expect(dialog.accept).toHaveBeenCalledWith('Grace');
    session.dispose();
  });

  it('surfaces a dialog when Puppeteer keeps the click pending until its locator timeout', async () => {
    const current = fakePage('https://example.test');
    const dialog = fakeDialog();
    current.locator.click.mockImplementation(async () => {
      current.page.emit('dialog', dialog);
      throw new Error('Timed out after waiting 5000ms');
    });
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const snapshot = await session.takeSnapshot();

    await expect(session.clickByUid(snapshot.root.id, 1)).rejects.toMatchObject({
      name: 'BrowserDialogOpenError',
      dialog: { type: 'prompt', message: 'Continue?' },
    });
    expect(current.locator.click).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('releases every held modifier when the primary key fails and never replays the action', async () => {
    const current = fakePage('https://example.test');
    current.page.keyboard.press = vi.fn(async () => {
      throw new Error('transport failed');
    });
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));

    await expect(session.pressKey('Control+Shift+R')).rejects.toThrow('transport failed');
    expect(current.page.keyboard.down).toHaveBeenNthCalledWith(1, 'Control');
    expect(current.page.keyboard.down).toHaveBeenNthCalledWith(2, 'Shift');
    expect(current.page.keyboard.press).toHaveBeenCalledOnce();
    expect(current.page.keyboard.up).toHaveBeenNthCalledWith(1, 'Shift');
    expect(current.page.keyboard.up).toHaveBeenNthCalledWith(2, 'Control');
    session.dispose();
  });

  it('uses the upstream UID action error and does not replay the interaction', async () => {
    const current = fakePage('https://example.test');
    const failure = new Error('transport failed during click');
    current.locator.click.mockRejectedValue(failure);
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const snapshot = await session.takeSnapshot();

    await expect(session.clickByUid(snapshot.root.id, 1)).rejects.toMatchObject({
      message:
        `Failed to interact with the element with uid ${snapshot.root.id}. ` +
        'The element did not become interactive within the configured timeout.',
      cause: failure,
    });
    expect(current.locator.click).toHaveBeenCalledOnce();
    expect(current.handle.dispose).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('maps combobox option display text to its DOM value like upstream', async () => {
    const current = fakePage('https://example.test');
    current.root.role = 'combobox';
    current.root.name = 'Cabin';
    const valueHandle = {
      jsonValue: vi.fn(async () => 'business'),
      dispose: vi.fn(async () => undefined),
    };
    const optionHandle = {
      getProperty: vi.fn(async () => valueHandle),
      dispose: vi.fn(async () => undefined),
    };
    (current.root.children as unknown[]).push({
      role: 'MenuListPopup',
      children: [],
      elementHandle: vi.fn(async () => undefined),
    });
    (current.root.children[0].children as unknown[]).push({
      role: 'none',
      children: [{
        role: 'option',
        name: 'Business',
        value: 'Business',
        children: [],
        elementHandle: vi.fn(async () => optionHandle),
      }],
      elementHandle: vi.fn(async () => undefined),
    });
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const snapshot = await session.takeSnapshot();

    await session.fillByUid(snapshot.root.id, 'Business');

    expect(current.locator.fill).toHaveBeenCalledWith('business');
    session.dispose();
  });

  it('uses the upstream drag/drop sequence once and releases both handles', async () => {
    const current = fakePage('https://example.test');
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const snapshot = await session.takeSnapshot();

    await session.dragByUids(snapshot.root.id, snapshot.root.id);

    expect(current.handle.drag).toHaveBeenCalledOnce();
    expect(current.handle.drag).toHaveBeenCalledWith(current.handle);
    expect(current.handle.drop).toHaveBeenCalledOnce();
    expect(current.handle.drop).toHaveBeenCalledWith(current.handle);
    expect(current.handle.dispose).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it('uploads directly and falls back to a file chooser like upstream', async () => {
    const direct = fakePage('https://example.test/direct');
    const directSession = await BrowserAutomationSession.create(fakeBrowser([direct.page]));
    const directSnapshot = await directSession.takeSnapshot();

    await directSession.uploadFileByUid(directSnapshot.root.id, '/workspace/direct.txt');
    expect(direct.handle.uploadFile).toHaveBeenCalledWith('/workspace/direct.txt');
    expect(direct.page.waitForFileChooser).not.toHaveBeenCalled();
    directSession.dispose();

    const chooser = fakePage('https://example.test/chooser');
    chooser.handle.uploadFile.mockRejectedValueOnce(new Error('not a file input'));
    const chooserSession = await BrowserAutomationSession.create(fakeBrowser([chooser.page]));
    const chooserSnapshot = await chooserSession.takeSnapshot();

    await chooserSession.uploadFileByUid(chooserSnapshot.root.id, '/workspace/chooser.txt');
    expect(chooser.page.waitForFileChooser).toHaveBeenCalledWith({ timeout: 3_000 });
    expect(chooser.locator.click).toHaveBeenCalledOnce();
    expect(chooser.fileChooser.accept).toHaveBeenCalledWith(['/workspace/chooser.txt']);
    chooserSession.dispose();
  });

  it('rejects invalid keys before pressing a modifier like upstream', async () => {
    const current = fakePage('https://example.test');
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));

    await expect(session.pressKey('Control+NotAKey')).rejects.toThrow('NotAKey is invalid');
    expect(current.page.keyboard.down).not.toHaveBeenCalled();
    session.dispose();
  });

  it('disposes browser and page listeners idempotently', async () => {
    const current = fakePage('https://example.test');
    const browser = fakeBrowser([current.page]);
    const session = await BrowserAutomationSession.create(browser);
    session.dispose();
    session.dispose();

    expect(browser.listenerCount('targetcreated')).toBe(0);
    expect(browser.listenerCount('targetdestroyed')).toBe(0);
    expect(current.page.listenerCount('dialog')).toBe(0);
    expect(current.page.listenerCount('framenavigated')).toBe(0);
  });
});

describe('ActionWaiter', () => {
  afterEach(() => vi.useRealTimers());

  it('reports navigation and DOM settlement from a single dispatched action', async () => {
    const current = fakePage('https://example.test/before');
    const action = vi.fn(async () => {
      current.client.emit('Page.frameStartedNavigating', { navigationType: 'differentDocument' });
      current.page.setUrl('https://example.test/after');
    });

    await expect(new ActionWaiter(current.page).run(action)).resolves.toMatchObject({
      navigated: true,
      navigatedToUrl: 'https://example.test/after',
      domSettled: true,
    });
    expect(action).toHaveBeenCalledOnce();
  });

  it('uses the upstream start probe and still waits when navigation finishes after 100ms', async () => {
    const current = fakePage('https://example.test/before');
    let finishNavigation!: () => void;
    const waitForNavigation = vi.fn(() => new Promise<null>((resolve) => {
      finishNavigation = () => resolve(null);
    }));
    current.page.waitForNavigation = waitForNavigation;
    const action = vi.fn(async () => {
      current.client.emit('Page.frameStartedNavigating', { navigationType: 'differentDocument' });
      current.page.setUrl('https://example.test/after');
    });

    const waiting = new ActionWaiter(current.page).run(action);
    await vi.waitFor(() => expect(waitForNavigation).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 150));
    const navigationSignal = waitForNavigation.mock.calls[0]?.[0]?.signal;
    expect(navigationSignal?.aborted).toBe(false);
    expect(current.page.evaluateHandle).not.toHaveBeenCalled();

    finishNavigation();
    await expect(waiting).resolves.toMatchObject({
      navigated: true,
      navigatedToUrl: 'https://example.test/after',
      domSettled: true,
    });
  });

  it('absorbs a stale execution context from the post-action DOM wait like upstream', async () => {
    const current = fakePage('https://example.test');
    current.page.evaluateHandle = vi.fn(async () => {
      throw new Error('Execution context was destroyed, most likely because of a navigation.');
    });

    await expect(new ActionWaiter(current.page).run(async () => undefined)).resolves.toMatchObject({
      navigated: false,
      domSettled: false,
    });
  });

  it('surfaces an unhandled dialog without waiting on the paused DOM', async () => {
    const current = fakePage('https://example.test');
    const dialog = fakeDialog('alert');
    const receipt = await new ActionWaiter(current.page).run(async () => {
      current.page.emit('dialog', dialog);
    });

    expect(receipt.dialog).toMatchObject({ type: 'alert', message: 'Continue?', handled: false });
    expect(receipt.domSettled).toBe(false);
    expect(current.page.evaluateHandle).not.toHaveBeenCalled();
  });

  it('dispatches the configured dialog action without waiting for it', async () => {
    const current = fakePage('https://example.test');
    const dialog = fakeDialog('beforeunload');

    await expect(new ActionWaiter(current.page).run(async () => {
      current.page.emit('dialog', dialog);
    }, {
      handleDialog: { beforeunload: 'accept' },
    })).resolves.toMatchObject({
      dialog: { type: 'beforeunload', message: 'Continue?', handled: true },
      domSettled: false,
    });
    expect(dialog.accept).toHaveBeenCalledOnce();
    expect(current.page.evaluateHandle).not.toHaveBeenCalled();
  });

  it('bounds stable-DOM observer setup when the renderer does not respond', async () => {
    vi.useFakeTimers();
    const current = fakePage('https://example.test');
    current.page.evaluateHandle = vi.fn(() => new Promise<never>(() => undefined));
    const waiting = new ActionWaiter(current.page).run(async () => undefined);

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(current.page.evaluateHandle).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(waiting).resolves.toMatchObject({
      navigated: false,
      domSettled: false,
    });
  });
});
