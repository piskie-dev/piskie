import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser, Dialog, Frame, Page } from 'puppeteer-core';
import { ActionWaiter } from '../action-waiter.js';
import { BrowserAutomationSession, BrowserDialogOpenError } from '../browser-automation-session.js';
import { PageRegistry } from '../page-registry.js';
import { formatTextSnapshot, resetSnapshotIdsForTesting } from '../text-snapshot.js';

function fakePage(url: string) {
  const events = new EventEmitter();
  const client = new EventEmitter();
  let currentUrl = url;
  const frame = Object.assign(new EventEmitter(), { _id: 'main-frame', page: () => page }) as unknown as Frame;
  const locator = {
    click: vi.fn(async (_options?: { count?: number; signal?: AbortSignal }) => undefined),
    fill: vi.fn(async (_value?: string | boolean, _options?: { signal?: AbortSignal }) => undefined),
    hover: vi.fn(async (_options?: { signal?: AbortSignal }) => undefined),
    setTimeout: vi.fn(),
  };
  locator.setTimeout.mockReturnValue(locator);
  const handle = {
    frame,
    evaluateHandle: vi.fn(async () => ({ asElement: () => null, dispose: vi.fn(async () => undefined) })),
    dispose: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => false),
    asLocator: vi.fn(() => locator),
    drag: vi.fn(async () => undefined),
    drop: vi.fn(async () => undefined),
    uploadFile: vi.fn(async () => undefined),
  };
  const root = {
    backendNodeId: 1,
    loaderId: 'document-a',
    role: 'button',
    name: 'Continue',
    value: 'ready',
    children: [] as Array<{ children: unknown[] }>,
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
    browserContext: () => null,
    bringToFront: vi.fn(async () => undefined),
    close: vi.fn(async () => { vi.mocked(page.isClosed).mockReturnValue(true); events.emit('close'); }),
    mainFrame: vi.fn(() => frame),
    isClosed: vi.fn(() => false),
    emulateFocusedPage: vi.fn(async () => undefined),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    getDefaultTimeout: vi.fn(() => 5_000),
    _client: vi.fn(() => client),
    accessibility: { snapshot: vi.fn(async () => root) },
    waitForNavigation: vi.fn((options: { signal: AbortSignal }) => new Promise<null>((resolve, reject) => {
      const navigation = (event: { frameId: string; navigationType: string }) => {
        if (event.frameId === 'main-frame' && !['sameDocument', 'historySameDocument'].includes(event.navigationType)) resolve(null);
      };
      client.on('Page.frameStartedNavigating', navigation);
      options.signal.addEventListener('abort', () => {
        client.off('Page.frameStartedNavigating', navigation);
        reject(options.signal.reason);
      }, { once: true });
    })),
    waitForFileChooser: vi.fn(async () => fileChooser),
    evaluate: vi.fn(async () => true),
    evaluateHandle: vi.fn(async () => stableDomHandle),
    mouse: { move: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}) },
    keyboard: {
      down: vi.fn(async () => undefined),
      press: vi.fn(async () => undefined),
      up: vi.fn(async () => undefined),
      type: vi.fn(async () => undefined),
    },
  }) as unknown as Page & { setUrl(value: string): void };
  return { page, frame, client, fileChooser, handle, locator, root, stableDomHandle };
}

function fakeBrowser(pages: Page[]) {
  const events = new EventEmitter();
  return Object.assign(events, {
    pages: vi.fn(async () => pages.filter((page) => !page.isClosed())),
    newPage: vi.fn(),
    defaultBrowserContext: () => null,
    browserContexts: () => [],
    targets: () => [],
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

  it('binds real mouse observations to the registry navigation at call time and restores every page on disposal', async () => {
    const first = fakePage('https://example.test/sample');
    const second = fakePage('https://example.test/next');
    const originalMove = first.page.mouse.move;
    const session = await BrowserAutomationSession.create(fakeBrowser([first.page, second.page]));
    const events: import('../browser-automation-session.js').BrowserScreenEvent[] = [];
    session.subscribeScreen((event) => events.push(event));
    const firstTarget = session.getScreenTarget();
    const pending = first.page.mouse.move(70, 90);
    first.page.emit('framenavigated', first.frame);
    await pending;
    expect(events[0]).toMatchObject({ type: 'feedback', pointer: { origin: 'initial', action: 'initialize', seq: 0 } });
    expect(events[1]).toMatchObject({ type: 'target', target: { identity: { navigationSequence: 1 } } });
    expect(events[2]).toMatchObject({ type: 'pointer', pointer: { page: firstTarget.identity, x: 70, y: 90 } });
    expect(session.getCurrentScreenPointer()).toMatchObject({ page: firstTarget.identity, x: 70, y: 90 });
    await session.selectPageByIndex(1);
    expect(session.getScreenTarget()!.identity.pageId).not.toBe(firstTarget.identity.pageId);
    await second.page.mouse.move(30, 40);
    expect(events.at(-1)).toMatchObject({ type: 'pointer', pointer: { page: session.getScreenTarget()!.identity } });
    session.dispose();
    expect(events.at(-1)).toEqual({ type: 'target', target: null });
    expect(first.page.mouse.move).toBe(originalMove);
    expect(first.page.listenerCount('framenavigated')).toBe(0);
  });

  it('replays a recent successful short click to the first screen subscriber', async () => {
    const current = fakePage('https://example.test/sample');
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    await current.page.mouse.move(80, 120);
    await current.page.mouse.down();
    await current.page.mouse.up();
    const events: import('../browser-automation-session.js').BrowserScreenEvent[] = [];
    session.subscribeScreen((event) => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'pointer', pointer: { buttons: 0, press: { x: 80, y: 120 } } });
    session.dispose();
  });

  it('keeps idle position through navigation, restores each Page on return and clears on disposal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = fakePage('https://example.test/sample');
    const second = fakePage('https://example.test/next');
    const session = await BrowserAutomationSession.create(fakeBrowser([first.page, second.page]));
    await first.page.mouse.move(80, 120);
    await first.page.mouse.down();
    await first.page.mouse.up();
    const source = session.getCurrentScreenPointer()!;
    vi.setSystemTime(source.timestamp + 1500);
    expect(session.getCurrentScreenPointer()).toMatchObject({ timestamp: source.timestamp, press: { seq: 2 } });
    vi.setSystemTime(source.timestamp + 5001);
    const stale = vi.fn();
    session.subscribeScreen(stale)();
    expect(stale).toHaveBeenCalledOnce();
    expect(stale.mock.calls[0]![0]).toMatchObject({ type: 'pointer', pointer: { x: 80, y: 120, timestamp: source.timestamp, press: undefined } });
    await first.page.mouse.move(90, 130);
    const beforeNavigation = session.getCurrentScreenPointer();
    first.page.emit('framenavigated', first.frame);
    expect(session.getCurrentScreenPointer()).toMatchObject({ page: beforeNavigation!.page, seq: beforeNavigation!.seq, timestamp: beforeNavigation!.timestamp,
      activity: { kind: 'navigation', page: session.getScreenTarget()!.identity } });
    expect(session.getCurrentScreenPointer()!.page.navigationSequence).toBe(0);
    expect(session.getScreenTarget()!.identity.navigationSequence).toBe(1);
    await first.page.mouse.move(100, 140);
    await session.selectPageByIndex(1);
    expect(session.getCurrentScreenPointer()).toMatchObject({ origin: 'initial', x: 24, y: 24 });
    await session.selectPageByIndex(0);
    expect(session.getCurrentScreenPointer()).toMatchObject({ origin: 'mouse', x: 100, y: 140 });
    await first.page.mouse.move(110, 150);
    session.dispose();
    expect(session.getCurrentScreenPointer()).toBeNull();
  });

  it('keeps one real Mouse position across navigation without forging an observation and preserves the original press frame', async () => {
    const current = fakePage('https://example.test/sample');
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const mouse = current.page.mouse;
    const listener = vi.fn();
    session.subscribeScreen(listener);
    await mouse.move(80, 120);
    await mouse.down();
    const down = session.getCurrentScreenPointer()!;
    current.page.emit('framenavigated', current.frame);
    expect(current.page.mouse).toBe(mouse);
    expect(session.getCurrentScreenPointer()).toMatchObject({ page: down.page, seq: down.seq, timestamp: down.timestamp, press: down.press });
    expect(listener.mock.calls.filter(([event]) => event.type === 'pointer')).toHaveLength(2);
    expect(listener.mock.calls.at(-1)![0].type).toBe('target');
    await mouse.up();
    const up = session.getCurrentScreenPointer()!;
    expect(up).toMatchObject({ page: session.getScreenTarget()!.identity, seq: 3, x: 80, y: 120,
      buttons: 0, press: { page: down.page, seq: 2 } });
    current.page.emit('framenavigated', current.frame);
    expect(session.getCurrentScreenPointer()).toMatchObject({ page: up.page, seq: up.seq, timestamp: up.timestamp, press: up.press });
    expect(up.page.navigationSequence).toBe(1);
    expect(up.press!.page.navigationSequence).toBe(0);
    const replay = vi.fn();
    session.subscribeScreen(replay)();
    expect(replay.mock.calls[0]![0].pointer).toMatchObject({ page: up.page, seq: up.seq, timestamp: up.timestamp, press: up.press });
    session.dispose();
  });

  it('aggregates concurrent successful click acknowledgements at the session observation owner', async () => {
    const current = fakePage('https://example.test/sample');
    let finishDown!: () => void;
    vi.mocked(current.page.mouse.down).mockImplementation(() => new Promise<void>((yes) => { finishDown = yes; }));
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    await current.page.mouse.move(80, 120);
    const down = current.page.mouse.down();
    await current.page.mouse.up();
    finishDown();
    await down;
    expect(session.getCurrentScreenPointer()).toMatchObject({ seq: 3, action: 'up', buttons: 0, press: { seq: 2 } });
    const listener = vi.fn();
    session.subscribeScreen(listener)();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0].pointer).toBe(session.getCurrentScreenPointer());
    session.dispose();
  });

  it('keeps a manual release current when its older move completes late, with original origin seq/time', async () => {
    const current = fakePage('https://example.test/sample');
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const identity = session.getScreenTarget()!.identity;
    const firstOrder = session.reserveInputOrder();
    const nextOrder = session.reserveInputOrder();
    session.observeManualInput({ page: current.page, identity, seq: 2, timestamp: 200,
      sourceOrder: nextOrder, event: { kind: 'mouse', type: 'mouseReleased', x: 200, y: 100, buttons: 0 } });
    session.observeManualInput({ page: current.page, identity, seq: 1, timestamp: 100,
      sourceOrder: firstOrder, event: { kind: 'mouse', type: 'mouseMoved', x: 60, y: 40, buttons: 1 } });
    expect(session.getCurrentScreenPointer()).toMatchObject({ actor: 'manual', page: identity, seq: 2, timestamp: 200,
      x: 200, y: 100, buttons: 0, action: 'up' });
    session.dispose();
  });

  it('does not replay old press feedback when switching away and returning to a known Page', async () => {
    const first = fakePage('https://example.test/sample');
    const second = fakePage('https://example.test/next');
    const session = await BrowserAutomationSession.create(fakeBrowser([first.page, second.page]));
    await first.page.mouse.move(80, 120); await first.page.mouse.down(); await first.page.mouse.up();
    const source = session.getCurrentScreenPointer()!;
    await session.selectPageByIndex(1); await session.selectPageByIndex(0);
    expect(session.getCurrentScreenPointer()).toMatchObject({ page: source.page, seq: source.seq, timestamp: source.timestamp,
      x: 80, y: 120, press: undefined });
    session.dispose();
  });

  it('does not let a failed display consumer prevent the actual keyboard action', async () => {
    const current = fakePage('https://example.test/sample');
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    session.subscribeScreen(() => { throw new Error('Sample display consumer failure'); });
    await expect(session.typeText('Sample input')).resolves.toMatchObject({ domSettled: true });
    expect(current.page.keyboard.type).toHaveBeenCalledExactlyOnceWith('Sample input');
    session.dispose();
    expect(current.page.listenerCount('framedetached')).toBe(0);
  });

  it('keeps page-local snapshots and reuses observed identities across selection and navigation', async () => {
    const first = fakePage('https://example.test/first');
    const second = fakePage('https://example.test/second');
    const session = await BrowserAutomationSession.create(fakeBrowser([first.page, second.page]));
    const initial = await session.takeSnapshot();
    const replacement = await session.takeSnapshot();
    expect(replacement.root.id).toBe(initial.root.id);
    expect(replacement.snapshotId).not.toBe(initial.snapshotId);
    await expect(session.getElementByUid(initial.root.id)).resolves.toBe(first.handle);
    await session.selectPageByIndex(1);
    await expect(session.getElementByUid(initial.root.id)).rejects.toThrow('No snapshot found for page 2');
    const secondSnapshot = await session.takeSnapshot();
    second.page.emit('framenavigated', second.frame);
    await expect(session.getElementByUid(secondSnapshot.root.id)).resolves.toBe(second.handle);
    await session.selectPageByIndex(0);
    await expect(session.getElementByUid(initial.root.id)).resolves.toBe(first.handle);
    expect(session.getActiveSnapshot()).toBe(replacement);
    session.dispose();
  });

  it('preserves observable accessibility values in formatted snapshots', async () => {
    const current = fakePage('https://example.test');
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));

    const snapshot = await session.takeSnapshot();
    expect(formatTextSnapshot(snapshot)).toContain('uid=1_0 button "Continue" value="ready"');
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

    await expect(session.clickByUid(snapshot.root.id, 1)).resolves.toMatchObject({ dialog: { handled: false } });
    expect(browser.pages).toHaveBeenCalledOnce();
    expect(current.handle.dispose).toHaveBeenCalledOnce();

    await session.handleDialog('accept', 'Sample response');
    expect(dialog.accept).toHaveBeenCalledWith('Sample response');
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

    await expect(session.clickByUid(snapshot.root.id, 1)).resolves.toMatchObject({
      interrupted: true, dialog: { type: 'prompt', message: 'Continue?', handled: false },
    });
    expect(current.locator.click).toHaveBeenCalledOnce();
    session.dispose();
  });

  it.each(['  Hello 中文😀\nSecond paragraph\n\nEnd  ', '   ', '\n', ''])(
    'types unchanged text %j on the selected page and returns its action receipt',
    async (text) => {
      const first = fakePage('https://example.test/first');
      const selected = fakePage('https://example.test/selected');
      const session = await BrowserAutomationSession.create(fakeBrowser([first.page, selected.page]));
      await session.selectPageByIndex(1);
      const waitForAction = vi.spyOn(session, 'waitForAction');

      await expect(session.typeText(text)).resolves.toMatchObject({
        navigated: false,
        domSettled: true,
        openedPageIds: [],
        closedPageIds: [],
      });
      expect(selected.page.keyboard.type).toHaveBeenCalledExactlyOnceWith(text);
      expect(first.page.keyboard.type).not.toHaveBeenCalled();
      expect(selected.page.keyboard.press).not.toHaveBeenCalled();
      expect(selected.locator.click).not.toHaveBeenCalled();
      expect(selected.locator.fill).not.toHaveBeenCalled();
      expect(waitForAction).toHaveBeenCalledOnce();
      session.dispose();
    }
  );

  it('retains the type_text source result path for a newly opened dialog', async () => {
    const current = fakePage('https://example.test');
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const dialog = fakeDialog('alert');
    vi.mocked(current.page.keyboard.type).mockImplementationOnce(async () => { current.page.emit('dialog', dialog); });
    await expect(session.typeText('Sample text')).resolves.toMatchObject({ dialog: { type: 'alert', handled: false } });
    expect(current.page.evaluateHandle).not.toHaveBeenCalled();
    await session.handleDialog('dismiss');
    session.dispose();
  });

  it('propagates a typing failure without replaying partially entered text', async () => {
    const current = fakePage('https://example.test');
    const failure = new Error('keyboard transport failed');
    vi.mocked(current.page.keyboard.type).mockRejectedValueOnce(failure);
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));

    await expect(session.typeText('example')).rejects.toBe(failure);
    expect(current.page.keyboard.type).toHaveBeenCalledOnce();
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
        'transport failed during click',
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
      jsonValue: vi.fn(async () => 'sample-option'),
      dispose: vi.fn(async () => undefined),
    };
    const optionHandle = {
      getProperty: vi.fn(async () => valueHandle),
      dispose: vi.fn(async () => undefined),
    };
    (current.root.children as unknown[]).push({
      backendNodeId: 2, loaderId: 'document-a', role: 'option', name: 'Sample option',
      value: 'Sample option', children: [], elementHandle: vi.fn(async () => optionHandle),
    });
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const snapshot = await session.takeSnapshot();

    await session.fillByUid(snapshot.root.id, 'Sample option');

    expect(current.locator.fill).toHaveBeenCalledWith('sample-option', { signal: expect.any(AbortSignal) });
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

describe('page routing, batch actions, and display target', () => {
  beforeEach(() => { PageRegistry.resetPageIdsForTesting(); resetSnapshotIdsForTesting(); });

  function form(size: number) {
    const current = fakePage('https://example.test/form');
    const fields = Array.from({ length: size }, (_, index) => {
      const field = fakePage('https://example.test/unused');
      field.handle.frame = current.frame;
      field.root.backendNodeId = index + 2;
      field.root.role = 'textbox';
      field.root.name = `Sample field ${index + 1}`;
      (current.root.children as unknown[]).push(field.root);
      return field;
    });
    return { current, fields };
  }

  it('routes UID and keyboard actions to B and displays B while A remains logically selected', async () => {
    const first = fakePage('https://example.test/a');
    const second = fakePage('https://example.test/b');
    const session = await BrowserAutomationSession.create(fakeBrowser([first.page, second.page]));
    const snapshot = await session.takeSnapshot(false, 2);
    const selectedSnapshot = await session.takeSnapshot(false, 1);
    const events: import('../browser-automation-session.js').BrowserScreenEvent[] = [];
    session.subscribeScreen((event) => events.push(event));
    await session.withTarget(2, async (target) => {
      expect(target).toBe(second.page);
      expect(session.getPage()).toBe(second.page);
      expect(session.getSelectedPage()).toBe(first.page);
      expect(session.getScreenTarget()?.page).toBe(second.page);
      await session.fillByUid(snapshot.root.id, 'Sample input');
      await second.page.mouse.move(80, 120);
      expect(session.getCurrentScreenPointer()).toMatchObject({ page: { pageId: 2 }, x: 80, y: 120 });
      await session.typeText('Sample suffix', 'Enter');
      expect(session.getSelectedPageId()).toBe(1);
    }, { feedback: true });
    expect(first.locator.fill).not.toHaveBeenCalled();
    expect(second.page.keyboard.press).toHaveBeenCalledExactlyOnceWith('Enter');
    expect(first.page.keyboard.type).not.toHaveBeenCalled();
    expect(session.getScreenTarget()?.page).toBe(first.page);
    expect(session.getActiveSnapshot()).toBe(selectedSnapshot);
    expect(events.filter((event) => event.type === 'target').map((event) => event.type === 'target' ? event.target?.identity.pageId : null)).toEqual([2, 1]);
    expect(first.page.bringToFront).not.toHaveBeenCalled();
    expect(second.page.bringToFront).not.toHaveBeenCalled();
    session.dispose();
  });

  it('preserves the actual interaction error when B closes during dispatch', async () => {
    const first = fakePage('https://example.test/a');
    const second = fakePage('https://example.test/b');
    const session = await BrowserAutomationSession.create(fakeBrowser([first.page, second.page]));
    const snapshot = await session.takeSnapshot(false, 2);
    const failure = new Error('Sample target closed during click');
    second.locator.click.mockImplementation(async () => { await second.page.close(); throw failure; });
    await expect(session.clickByUid(snapshot.root.id, 1, 2)).rejects.toMatchObject({
      message: `Failed to interact with the element with uid ${snapshot.root.id}. Sample target closed during click`, cause: failure,
    });
    expect(session.getSelectedPageId()).toBe(1);
    expect(session.getScreenTarget()?.page).toBe(first.page);
    session.clearDialog(2);
    session.dispose();
  });

  it('restores the registry selection at completion and after an error instead of saving old A', async () => {
    const pages = [fakePage('https://example.test/a'), fakePage('https://example.test/b'), fakePage('https://example.test/c')];
    const session = await BrowserAutomationSession.create(fakeBrowser(pages.map(({ page }) => page)));
    const failure = new Error('Sample operation failure');
    await expect(session.withTarget(2, async () => {
      await session.selectPageById(3);
      expect(session.getPage()).toBe(pages[1].page);
      expect(session.getScreenTarget()?.page).toBe(pages[1].page);
      throw failure;
    }, { feedback: true })).rejects.toBe(failure);
    expect(session.getSelectedPageId()).toBe(3);
    expect(session.getScreenTarget()?.page).toBe(pages[2].page);
    await session.selectPageById(1, true);
    expect(pages[0].page.bringToFront).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('restores display immediately when a scoped operation is cancelled, including a still-pending callback', async () => {
    const first = fakePage('https://example.test/a');
    const second = fakePage('https://example.test/b');
    const session = await BrowserAutomationSession.create(fakeBrowser([first.page, second.page]));
    const controller = new AbortController();
    let finish!: () => void;
    const operation = session.withTarget(2, () => new Promise<void>((resolve) => { finish = resolve; }), {
      feedback: true, signal: controller.signal,
    });
    expect(session.getScreenTarget()?.page).toBe(second.page);
    controller.abort(new Error('Sample cancellation'));
    expect(session.getScreenTarget()?.page).toBe(first.page);
    expect(session.getSelectedPageId()).toBe(1);
    finish();
    await operation;
    session.dispose();
  });

  it('stops display when all pages close and never resolves an unknown ID through a list index', async () => {
    const first = fakePage('https://example.test/a');
    const second = fakePage('https://example.test/b');
    const session = await BrowserAutomationSession.create(fakeBrowser([first.page, second.page]));
    await expect(session.withTarget(99, () => undefined, { feedback: true })).rejects.toThrow('No page found');
    await session.withTarget(2, async () => {
      await first.page.close();
      await second.page.close();
      expect(session.getScreenTarget()).toBeNull();
    }, { feedback: true });
    expect(session.getScreenTarget()).toBeNull();
    expect(session.getCurrentScreenPointer()).toBeNull();
    session.dispose();
  });

  it('routes passive data reads without an input or display feedback boundary and shares actual collectors', async () => {
    const first = fakePage('https://example.test/a');
    const second = fakePage('https://example.test/b');
    const session = await BrowserAutomationSession.create(fakeBrowser([first.page, second.page]));
    const firstConsole = session.getConsoleCollector(1);
    const secondConsole = session.getConsoleCollector(2);
    const secondNetwork = session.getNetworkCollector(2);
    const events = vi.fn(); session.subscribeScreen(events); events.mockClear();
    await session.withTarget(2, () => {
      expect(session.getConsoleCollector()).toBe(secondConsole);
      expect(session.getNetworkCollector()).toBe(secondNetwork);
      expect(session.getConsoleData()).toEqual(secondConsole.getData());
      expect(session.getNetworkRequests()).toEqual(secondNetwork.getData());
      expect(session.getScreenTarget()?.page).toBe(first.page);
    });
    expect(firstConsole).not.toBe(secondConsole);
    expect(events).not.toHaveBeenCalled();
    expect(session.getServiceWorkerConsoleData('sample-worker')).toEqual([]);
    session.dispose();
  });

  it('fills ten fields in order with one outer wait, one shared signal, and no hidden AX or page enumeration', async () => {
    const { current, fields } = form(10);
    const browser = fakeBrowser([current.page]);
    const session = await BrowserAutomationSession.create(browser);
    const snapshot = await session.takeSnapshot();
    const wait = vi.spyOn(session, 'waitForAction');
    const order: number[] = [];
    fields.forEach((field, index) => field.locator.fill.mockImplementation(async () => { order.push(index); }));
    const elements = snapshot.root.children.map((node, index) => ({ uid: node.id, value: `Sample value ${index}` }));
    await session.fillFormByUids(elements);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(wait).toHaveBeenCalledOnce();
    const signal = fields[0].locator.fill.mock.calls[0][1].signal;
    for (let index = 0; index < fields.length; index++) {
      expect(fields[index].locator.fill).toHaveBeenCalledExactlyOnceWith(elements[index].value, { signal });
      expect(fields[index].locator.setTimeout).toHaveBeenCalledWith(5000 + elements[index].value.length * 10);
    }
    expect(signal.aborted).toBe(true);
    expect(current.page.accessibility.snapshot).toHaveBeenCalledOnce();
    expect(browser.pages).toHaveBeenCalledOnce();
    expect(session.getActiveSnapshot()).toBe(snapshot);
    session.dispose();
  });

  it('stops remaining form fields on a dialog and records the source interrupted UID', async () => {
    const { current, fields } = form(3);
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const snapshot = await session.takeSnapshot();
    const dialog = fakeDialog('alert');
    fields[1].locator.fill.mockImplementation(async () => { current.page.emit('dialog', dialog); });
    const elements = snapshot.root.children.map((node) => ({ uid: node.id, value: 'Sample value' }));
    await expect(session.fillFormByUids(elements)).resolves.toMatchObject({ interrupted: true, interruptedUid: elements[1].uid, dialog: { handled: false } });
    expect(fields[0].locator.fill).toHaveBeenCalledOnce();
    expect(fields[1].locator.fill).toHaveBeenCalledOnce();
    expect(fields[2].root.elementHandle).not.toHaveBeenCalled();
    expect(current.page.accessibility.snapshot).toHaveBeenCalledOnce();
    await session.handleDialog('dismiss');
    session.dispose();
  });

  it('attributes a dialog during the next handle recovery to the previous UID as the source does', async () => {
    const { current, fields } = form(2);
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const snapshot = await session.takeSnapshot();
    fields[1].root.elementHandle.mockImplementation(async () => {
      current.page.emit('dialog', fakeDialog('alert'));
      return fields[1].handle;
    });
    const elements = snapshot.root.children.map((node) => ({ uid: node.id, value: 'Sample value' }));
    await expect(session.fillFormByUids(elements)).resolves.toMatchObject({ interruptedUid: elements[0].uid });
    expect(fields[1].locator.fill).not.toHaveBeenCalled();
    await session.handleDialog('dismiss');
    session.dispose();
  });

  it('propagates the actual ordinary field failure and stops later fields without replay or rollback', async () => {
    const { current, fields } = form(3);
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const snapshot = await session.takeSnapshot();
    const failure = new Error('Sample unsupported field');
    fields[1].locator.fill.mockRejectedValueOnce(failure);
    const elements = snapshot.root.children.map((node) => ({ uid: node.id, value: 'Sample value' }));
    await expect(session.fillFormByUids(elements)).rejects.toMatchObject({
      message: `Failed to interact with the element with uid ${elements[1].uid}. Sample unsupported field`, cause: failure,
    });
    expect(fields[0].locator.fill).toHaveBeenCalledOnce();
    expect(fields[2].root.elementHandle).not.toHaveBeenCalled();
    expect(session.getActiveSnapshot()).toBe(snapshot);
    session.dispose();
  });

  it('accepts multiple upload paths directly and via chooser without outer action waiting', async () => {
    const current = fakePage('https://example.test/upload');
    const session = await BrowserAutomationSession.create(fakeBrowser([current.page]));
    const snapshot = await session.takeSnapshot();
    const wait = vi.spyOn(session, 'waitForAction');
    const paths = ['/workspace/sample-a.txt', '/workspace/sample-b.txt'];
    await session.uploadFileByUid(snapshot.root.id, paths);
    expect(current.handle.uploadFile).toHaveBeenCalledExactlyOnceWith(...paths);
    current.handle.uploadFile.mockRejectedValueOnce(new Error('Sample proxy control'));
    await session.uploadFileByUid(snapshot.root.id, paths);
    expect(current.fileChooser.accept).toHaveBeenCalledWith(paths);
    expect(wait).not.toHaveBeenCalled();
    expect(current.page.accessibility.snapshot).toHaveBeenCalledOnce();
    session.dispose();
  });
});

describe('ActionWaiter', () => {
  afterEach(() => vi.useRealTimers());

  it('reports navigation and DOM settlement from a single dispatched action', async () => {
    const current = fakePage('https://example.test/before');
    const action = vi.fn(async () => {
      current.client.emit('Page.frameStartedNavigating', { frameId: 'main-frame', navigationType: 'differentDocument' });
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
    const waitForNavigation = vi.fn((_options?: Parameters<Page['waitForNavigation']>[0]) => new Promise<null>((resolve) => {
      finishNavigation = () => resolve(null);
    }));
    current.page.waitForNavigation = waitForNavigation;
    const action = vi.fn(async () => {
      current.client.emit('Page.frameStartedNavigating', { frameId: 'main-frame', navigationType: 'differentDocument' });
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
  it('installs navigation waiting before dispatch and observes navigation after a long batch action', async () => {
    vi.useFakeTimers();
    const current = fakePage('https://example.test/before');
    const action = vi.fn(async (signal: AbortSignal) => {
      expect(current.page.waitForNavigation).toHaveBeenCalledWith({ timeout: 0, signal, ignoreSameDocumentNavigation: true });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(current.client.listenerCount('Page.frameRequestedNavigation')).toBe(1);
      current.client.emit('Page.frameStartedNavigating', { frameId: 'main-frame', navigationType: 'differentDocument' });
      current.page.setUrl('https://example.test/after');
    });
    const waiting = new ActionWaiter(current.page).run(action);
    await vi.advanceTimersByTimeAsync(150);
    await expect(waiting).resolves.toMatchObject({ navigated: true, navigatedToUrl: 'https://example.test/after' });
    expect(current.client.listenerCount('Page.frameStartedNavigating')).toBe(0);
    expect(current.client.listenerCount('Page.frameRequestedNavigation')).toBe(0);
  });

  it('ignores child-frame and same-document probes, and skips only stable DOM when requested', async () => {
    vi.useFakeTimers();
    const current = fakePage('https://example.test/sample');
    const waiting = new ActionWaiter(current.page).run(async () => {
      current.client.emit('Page.frameStartedNavigating', { frameId: 'child-frame', navigationType: 'differentDocument' });
      current.client.emit('Page.frameStartedNavigating', { frameId: 'main-frame', navigationType: 'sameDocument' });
    }, { waitForStableDom: false });
    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).resolves.toMatchObject({ navigated: false, domSettled: false });
    expect(current.page.evaluateHandle).not.toHaveBeenCalled();
    expect(current.client.eventNames()).toEqual([]);
  });

  it('still observes requested main-frame navigation when stable DOM waiting is disabled', async () => {
    vi.useFakeTimers();
    const current = fakePage('https://example.test/sample');
    const waiting = new ActionWaiter(current.page).run(async () => {
      current.client.emit('Page.frameRequestedNavigation', { frameId: 'main-frame' });
    }, { waitForStableDom: false, navigationTimeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(19);
    const signal = vi.mocked(current.page.waitForNavigation).mock.calls[0][0]!.signal!;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toMatchObject({ navigated: true, domSettled: false });
    expect(signal.aborted).toBe(true);
    expect(current.page.evaluateHandle).not.toHaveBeenCalled();
  });

  it('aborts the action signal on an unhandled dialog and propagates ordinary action errors', async () => {
    const current = fakePage('https://example.test/sample');
    let actionSignal: AbortSignal | undefined;
    await expect(new ActionWaiter(current.page).run(async (signal) => {
      actionSignal = signal;
      current.page.emit('dialog', fakeDialog('alert'));
      signal.throwIfAborted();
    })).rejects.toThrow('Action interrupted by a dialog');
    expect(actionSignal?.aborted).toBe(true);
    expect(current.client.eventNames()).toEqual([]);
    expect(current.page.listenerCount('dialog')).toBe(0);
    const failure = new Error('Sample input failure');
    await expect(new ActionWaiter(current.page).run(async () => { throw failure; })).rejects.toBe(failure);
    expect(current.page.evaluateHandle).not.toHaveBeenCalled();
  });

  it('passes host cancellation to the full action and cleans every probe without replaying it', async () => {
    const current = fakePage('https://example.test/sample');
    const controller = new AbortController();
    const action = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const waiting = new ActionWaiter(current.page).run(action, { signal: controller.signal });
    const failure = new Error('Sample cancellation');
    controller.abort(failure);
    await expect(waiting).rejects.toBe(failure);
    expect(action).toHaveBeenCalledOnce();
    expect(current.client.eventNames()).toEqual([]);
    expect(current.page.listenerCount('dialog')).toBe(0);
  });

});
