import { EventEmitter } from 'node:events';
import type { Browser, ElementHandle, Frame, Page } from 'puppeteer-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAutomationSession } from '../browser-automation-session.js';
import { readOperationTarget, type ElementGeometry } from '../operation-target.js';
import { PageOperationFeedback } from '../page-operation-feedback.js';
import { SCREEN_POINTER_POLICY } from '@shared/screen-pointer.js';

vi.mock('../operation-target.js', () => ({ readOperationTarget: vi.fn(), resolveOperationFocus: vi.fn(async () => null) }));
vi.mock('../page-operation-feedback.js', () => ({ PageOperationFeedback: { capture: vi.fn(async () => null) } }));
const readGeometry = vi.mocked(readOperationTarget);
const geometry = (x = 80): ElementGeometry => ({ x: x + 50, y: 80, rect: { x, y: 60, width: 100, height: 40 }, scrollX: 0, scrollY: 0 });
const frame = (timestamp: number) => ({ width: 800, height: 600, scrollX: 0, scrollY: 0, timestamp });
function deferred() {
  let resolve!: (value: ElementGeometry | null) => void;
  const promise = new Promise<ElementGeometry | null>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function fakePage() {
  const target = {};
  const page = Object.assign(new EventEmitter(), { url: () => 'https://example.test/sample', target: () => target,
    mainFrame: () => mainFrame, isClosed: () => false, emulateFocusedPage: async () => {}, setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
    evaluate: vi.fn(), mouse: { move: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}) } }) as unknown as Page;
  const mainFrame = { page: () => page, parentFrame: () => null } as unknown as Frame;
  return page;
}
function element(page: Page) {
  const clone = { frame: page.mainFrame(), dispose: vi.fn(async () => {}) } as unknown as ElementHandle<Element>;
  const owned = { frame: page.mainFrame(), dispose: vi.fn(async () => {}),
    evaluateHandle: vi.fn(async () => ({ asElement: () => clone, dispose: vi.fn() })) } as unknown as ElementHandle<Element>;
  const handle = { frame: page.mainFrame(), evaluateHandle: vi.fn(async () => ({ asElement: () => owned, dispose: vi.fn() })) } as unknown as ElementHandle<Element>;
  return { handle, owned, clone };
}
let session: BrowserAutomationSession;
let pages: Page[];
beforeEach(async () => {
  vi.useFakeTimers();
  readGeometry.mockReset().mockResolvedValue(geometry());
  vi.mocked(PageOperationFeedback.capture).mockReset().mockResolvedValue(null as unknown as PageOperationFeedback);
  pages = [fakePage(), fakePage()];
  const browser = Object.assign(new EventEmitter(), { pages: async () => pages }) as unknown as Browser;
  session = await BrowserAutomationSession.create(browser);
});
afterEach(() => { session.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });
async function adopt(page = pages[0]!) {
  const previousSeq = session.getCurrentScreenPointer()?.target?.seq ?? 0;
  const handle = element(page);
  await session.input.element(handle.handle, 'input', async () => {});
  await ready(() => expect(session.getCurrentScreenPointer()?.target?.seq).toBeGreaterThan(previousSeq));
  return handle;
}
async function settle() { for (let step = 0; step < 12; step++) await Promise.resolve(); }
async function ready(assertion: () => void) { await settle(); assertion(); }

describe('active operation target frame refresh', () => {
  it('reads unchanged frame dimensions only for an active target and preserves the target clock on static pixels', async () => {
    const identity = session.getScreenTarget().identity;
    session.refreshTargetForFrame(identity, frame(100));
    expect(readGeometry).not.toHaveBeenCalled();
    expect(pages[0]!.evaluate).not.toHaveBeenCalled();
    await pages[0]!.mouse.move(650, 300);
    await adopt();
    const before = session.getCurrentScreenPointer()!;
    session.refreshTargetForFrame(identity, frame(200));
    await ready(() => expect(readGeometry).toHaveBeenCalledTimes(2));
    await settle();
    expect(session.getCurrentScreenPointer()).toMatchObject({ seq: before.seq, timestamp: before.timestamp, page: before.page, x: 650, y: 300,
      target: { seq: before.target!.seq, timestamp: before.target!.timestamp, rect: before.target!.rect } });
    session.refreshTargetForFrame(identity, frame(200));
    session.refreshTargetForFrame(identity, frame(150));
    expect(readGeometry).toHaveBeenCalledTimes(2);
  });

  it('refreshes distinct captured images with the same timestamp using the actual frame sequence', async () => {
    const identity = session.getScreenTarget().identity;
    session.refreshTargetForFrame(identity, { ...frame(100), seq: 1 });
    await adopt();
    readGeometry.mockResolvedValueOnce(geometry(280));
    session.refreshTargetForFrame(identity, { ...frame(100), seq: 2 });
    await ready(() => expect(session.getCurrentScreenPointer()?.target?.rect.x).toBe(280));
    expect(readGeometry).toHaveBeenCalledTimes(2);
    expect(session.getCurrentScreenPointer()?.target).toMatchObject({ frameSeq: 2, frameBefore: 100 });
    session.refreshTargetForFrame(identity, { ...frame(100), seq: 2 });
    expect(readGeometry).toHaveBeenCalledTimes(2);
  });

  it('coalesces newer frames behind one read and drops geometry returned for a superseded image', async () => {
    await adopt();
    const held = deferred();
    readGeometry.mockReturnValueOnce(held.promise).mockResolvedValueOnce(geometry(280));
    const identity = session.getScreenTarget().identity;
    session.refreshTargetForFrame(identity, frame(200));
    session.refreshTargetForFrame(identity, frame(210));
    session.refreshTargetForFrame(identity, frame(220));
    expect(readGeometry).toHaveBeenCalledTimes(2);
    held.resolve(geometry(180));
    await ready(() => expect(session.getCurrentScreenPointer()?.target?.rect.x).toBe(280));
    expect(readGeometry).toHaveBeenCalledTimes(3);
    expect(session.getCurrentScreenPointer()?.target).toMatchObject({ frameAfter: 220, frameBefore: 220 });
  });

  it('does not let an older geometry result overwrite the next input owner', async () => {
    const old = await adopt();
    const held = deferred();
    readGeometry.mockReturnValueOnce(held.promise);
    session.refreshTargetForFrame(session.getScreenTarget().identity, frame(200));
    readGeometry.mockResolvedValueOnce(geometry(280));
    const next = await adopt();
    const current = session.getCurrentScreenPointer()!;
    held.resolve(geometry(180));
    await settle();
    expect(session.getCurrentScreenPointer()).toBe(current);
    expect(old.owned.dispose).toHaveBeenCalledOnce();
    expect(next.owned.dispose).not.toHaveBeenCalled();
    session.dispose();
    expect(next.owned.dispose).toHaveBeenCalledOnce();
  });

  it('does not revive a deleted target from a concurrent operation feedback geometry read', async () => {
    const owned = await adopt();
    session.subscribeScreen(() => {});
    const disposed = vi.fn(async () => {});
    vi.mocked(PageOperationFeedback.capture).mockResolvedValueOnce({
      read: async () => ({ focus: null, focusChanged: false, effects: { changed: false, at: 0, scroll: { x: 0, y: 0 } } }),
      dispose: disposed,
    } as unknown as PageOperationFeedback);
    const held = deferred();
    readGeometry.mockReturnValueOnce(held.promise).mockResolvedValueOnce(null);
    await session.withOperationFeedback(async () => {});
    await ready(() => expect(readGeometry).toHaveBeenCalledTimes(2));
    session.refreshTargetForFrame(session.getScreenTarget().identity, frame(200));
    await ready(() => expect(session.getCurrentScreenPointer()?.target).toBeUndefined());
    held.resolve(geometry());
    await settle();
    expect(session.getCurrentScreenPointer()?.target).toBeUndefined();
    expect(session.getCurrentScreenPointer()?.positionTarget).toMatchObject({ x: 130, y: 80 });
    expect(owned.owned.dispose).toHaveBeenCalledOnce();
    expect(owned.clone.dispose).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('does not revive a released highlight when late geometry arrives after tab return', async () => {
    const owned = await adopt();
    const held = deferred();
    readGeometry.mockReturnValueOnce(held.promise);
    session.refreshTargetForFrame(session.getScreenTarget().identity, frame(200));
    await session.selectPageByIndex(1);
    await session.selectPageByIndex(0);
    const restored = session.getCurrentScreenPointer()!;
    held.resolve(geometry(280));
    await settle();
    expect(session.getCurrentScreenPointer()).toBe(restored);
    expect(restored).toMatchObject({ target: undefined, positionTarget: { x: 130, y: 80 } });
    expect(owned.owned.dispose).toHaveBeenCalledOnce();
  });

  it('fences geometry by current document and ignores frames from another Page or connection', async () => {
    await adopt();
    const held = deferred();
    readGeometry.mockReturnValueOnce(held.promise);
    const identity = session.getScreenTarget().identity;
    session.refreshTargetForFrame(identity, frame(200));
    pages[0]!.emit('framenavigated', pages[0]!.mainFrame());
    const navigated = session.getCurrentScreenPointer();
    held.resolve(geometry(280));
    await settle();
    expect(session.getCurrentScreenPointer()).toBe(navigated);
    session.refreshTargetForFrame(identity, frame(210));
    session.refreshTargetForFrame({ ...identity, pageId: identity.pageId + 1 }, frame(220));
    session.refreshTargetForFrame({ ...identity, connectionId: 'sample-new-connection' }, frame(230));
    expect(readGeometry).toHaveBeenCalledTimes(2);
  });

  it('releases disconnected geometry and stops all subsequent frame DOM reads', async () => {
    const owned = await adopt();
    readGeometry.mockResolvedValueOnce(null);
    const identity = session.getScreenTarget().identity;
    session.refreshTargetForFrame(identity, frame(200));
    await ready(() => expect(session.getCurrentScreenPointer()?.target).toBeUndefined());
    expect(owned.owned.dispose).toHaveBeenCalledOnce();
    expect(session.getCurrentScreenPointer()?.positionTarget).toMatchObject({ x: 130, y: 80 });
    session.refreshTargetForFrame(identity, frame(210));
    session.refreshTargetForFrame(identity, frame(220));
    expect(readGeometry).toHaveBeenCalledTimes(2);
  });

  it('releases a removed target within the feedback window even when no further frame is captured', async () => {
    const owned = await adopt();
    readGeometry.mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(SCREEN_POINTER_POLICY.targetObservationMs);
    expect(session.getCurrentScreenPointer()?.target).toBeUndefined();
    expect(session.getCurrentScreenPointer()?.positionTarget).toMatchObject({ x: 130, y: 80 });
    expect(owned.owned.dispose).toHaveBeenCalledOnce();
    const reads = readGeometry.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(readGeometry).toHaveBeenCalledTimes(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('withholds locally moved geometry from older pixels and admits it on the next real frame', async () => {
    vi.setSystemTime(1000);
    const identity = session.getScreenTarget().identity;
    session.refreshTargetForFrame(identity, { ...frame(1000), seq: 1 });
    await pages[0]!.mouse.move(650, 300);
    await adopt();
    const original = session.getCurrentScreenPointer()!;
    readGeometry.mockResolvedValue(geometry(280));
    await vi.advanceTimersByTimeAsync(SCREEN_POINTER_POLICY.targetObservationMs);
    expect(session.getCurrentScreenPointer()).toMatchObject({ x: 650, y: 300, seq: original.seq, timestamp: original.timestamp,
      target: { rect: { x: 280 }, frameAfter: 1080, frameBefore: 1000 }, positionTarget: { x: 130, y: 80 } });
    session.refreshTargetForFrame(identity, { ...frame(1100), seq: 2 });
    await settle();
    expect(session.getCurrentScreenPointer()).toMatchObject({ x: 650, y: 300,
      target: { x: 330, frameAfter: 1100, frameBefore: 1100, frameSeq: 2 }, positionTarget: undefined });
  });

  it('bounds local checking to fresh feedback and leaves no timers after that window', async () => {
    const owned = await adopt();
    await vi.advanceTimersByTimeAsync(SCREEN_POINTER_POLICY.feedbackFreshnessMs + 2 * SCREEN_POINTER_POLICY.targetObservationMs);
    const reads = readGeometry.mock.calls.length;
    expect(reads).toBeGreaterThan(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(readGeometry).toHaveBeenCalledTimes(reads);
    expect(owned.owned.dispose).not.toHaveBeenCalled();
    expect(session.getCurrentScreenPointer()?.target).toMatchObject({ x: 130, y: 80 });
  });

  it('releases retained handles and never publishes a geometry completion after disposal', async () => {
    const owned = await adopt();
    const held = deferred();
    const published = vi.fn();
    session.subscribeScreen(published);
    readGeometry.mockReturnValueOnce(held.promise);
    session.refreshTargetForFrame(session.getScreenTarget().identity, frame(200));
    session.dispose();
    const count = published.mock.calls.length;
    held.resolve(geometry(280));
    await settle();
    expect(owned.owned.dispose).toHaveBeenCalledOnce();
    expect(published).toHaveBeenCalledTimes(count);
    expect(session.getCurrentScreenPointer()).toBeNull();
  });
});
