import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserScreenEvent, BrowserScreenTarget } from '../core/session/browser-automation-session.js';
import { sameScreenPageInstance, type StreamServerMessage, type ScreenPageIdentity, type ScreenPointer } from '@shared/types/stream.js';
import { isRecentScreenPress, reduceScreenPointer } from '@shared/screen-pointer.js';

const mocks = vi.hoisted(() => {
  const getScreenSession = vi.fn();
  const casters: Array<{
    page: unknown; emit(type: string, value: unknown): boolean;
    start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>;
    setOptions: ReturnType<typeof vi.fn>; rebind: ReturnType<typeof vi.fn>; refreshFrame: ReturnType<typeof vi.fn>;
  }> = [];
  const sessionListeners = new Set<(session: unknown) => void>();
  const subscribeScreenSession = vi.fn((_id: string, listener: (session: unknown) => void) => {
    sessionListeners.add(listener); return () => sessionListeners.delete(listener);
  });
  return { casters, getScreenSession, sessionListeners, subscribeScreenSession,
    startFailure: null as Error | null, stopWait: null as Promise<void> | null };
});
vi.mock('../core/browser/browser-manager.js', () => ({ BrowserManager: { getScreenSession: mocks.getScreenSession, subscribeScreenSession: mocks.subscribeScreenSession } }));
vi.mock('../core/browser/screen-caster.js', () => ({
  ScreenCaster: class extends EventEmitter {
    readonly start = vi.fn(async () => {
      const error = mocks.startFailure;
      mocks.startFailure = null;
      if (error) throw error;
    });
    readonly stop = vi.fn(async () => {
      const pending = mocks.stopWait;
      mocks.stopWait = null;
      await pending;
    });
    readonly setOptions = vi.fn(async () => undefined);
    readonly rebind = vi.fn(async () => undefined);
    readonly refreshFrame = vi.fn(async () => undefined);
    constructor(readonly page: unknown) { super(); mocks.casters.push(this); }
  },
}));
import { ScreenStreamHub, type ViewerSink } from '../screen-hub.js';

const identity = (pageId = 1, navigationSequence = 0, connectionId = 'sample-connection'): ScreenPageIdentity => ({ pageId, navigationSequence, connectionId });
function sessionFixture(pageId = 1, connectionId = 'sample-connection') {
  let target = { page: {} as BrowserScreenTarget['page'], identity: identity(pageId, 0, connectionId) };
  const listeners = new Set<(event: BrowserScreenEvent) => void>();
  let recent: ScreenPointer | null = null;
  const session = { getScreenTarget: () => target,
    refreshTargetForFrame: vi.fn(), observeManualInput: vi.fn(),
    getCurrentScreenPointer: () => recent && recent.press && !isRecentScreenPress(recent.press.timestamp, Date.now())
      ? { ...recent, press: undefined } : recent,
    subscribeScreen: (listener: (event: BrowserScreenEvent) => void) => {
      listeners.add(listener);
      if (recent) listener({ type: 'pointer', pointer: recent });
      return () => listeners.delete(listener);
    } };
  return { session, listeners, get target() { return target; },
    emit: (event: BrowserScreenEvent) => {
      if (event.type === 'target') {
        if (!sameScreenPageInstance(recent?.page, event.target?.identity)) recent = null;
      } else if (sameScreenPageInstance(event.pointer.page, target.identity)) recent = reduceScreenPointer(recent, event.pointer);
      listeners.forEach((listener) => listener(event));
    },
    select(next: BrowserScreenTarget) { target = next; this.emit({ type: 'target', target }); },
  };
}
function sinkFixture() {
  const messages: StreamServerMessage[] = [];
  let open = true;
  const sink: ViewerSink = { send: (message) => messages.push(message), isOpen: () => open };
  return { sink, messages, close: () => { open = false; } };
}
function pointer(page: ScreenPageIdentity, seq = 1, action: ScreenPointer['action'] = 'move'): ScreenPointer {
  return { page, seq, action, x: 80, y: 120, buttons: action === 'down' ? 1 : 0, clickCount: 1, timestamp: Date.now() };
}
function castFrame(page: ScreenPageIdentity) {
  return { page, data: 'AA==', timestamp: Date.now(), deviceWidth: 800, deviceHeight: 600 };
}
let hub: ScreenStreamHub;
beforeEach(() => { vi.clearAllMocks(); mocks.casters.length = 0; mocks.sessionListeners.clear(); mocks.startFailure = null; mocks.stopWait = null; vi.useFakeTimers(); hub = new ScreenStreamHub(); });
afterEach(() => { hub.close(); vi.useRealTimers(); });

describe('ScreenStreamHub shared screen owner', () => {
  it('leaves a requested capture restart to rebind across concurrent page and navigation changes', async () => {
    const runtime = sessionFixture();
    mocks.getScreenSession.mockResolvedValue(runtime.session);
    const viewer = sinkFixture();
    await hub.addViewer('sample-browser', viewer.sink);
    const caster = mocks.casters[0]!;
    let finish!: () => void;
    caster.rebind.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const next = { page: {} as BrowserScreenTarget['page'], identity: identity(2) };
    runtime.select(next);
    runtime.select({ ...next, identity: identity(2, 1) });
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(caster.rebind).toHaveBeenCalledTimes(2);
    expect(caster.rebind).toHaveBeenLastCalledWith(next.page, identity(2, 1));
    expect(caster.start).toHaveBeenCalledOnce();
    caster.emit('frame', castFrame(identity(2, 1)));
    expect(viewer.messages.at(-1)).toMatchObject({ type: 'frame', meta: { page: identity(2, 1) } });
  });

  it('requests capture again after a null target and resumes the latest connected target', async () => {
    const runtime = sessionFixture();
    mocks.getScreenSession.mockResolvedValue(runtime.session);
    const viewer = sinkFixture();
    await hub.addViewer('sample-browser', viewer.sink);
    const caster = mocks.casters[0]!;
    runtime.emit({ type: 'target', target: null });
    expect(caster.stop).toHaveBeenCalledOnce();
    let finish!: () => void;
    caster.rebind.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const recovered = { page: {} as BrowserScreenTarget['page'], identity: identity(3, 0, 'sample-reconnected') };
    runtime.select(recovered);
    const navigated = { ...recovered, identity: identity(3, 1, 'sample-reconnected') };
    runtime.select(navigated);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(caster.start).toHaveBeenCalledTimes(2);
    caster.emit('frame', castFrame(navigated.identity));
    expect(viewer.messages.at(-1)).toMatchObject({ type: 'frame', meta: { page: navigated.identity } });
    runtime.select({ ...navigated, identity: identity(3, 2, 'sample-reconnected') });
    await Promise.resolve();
    expect(caster.start).toHaveBeenCalledTimes(2);
  });

  it('requests actual current pixels for pending local layout or removal and stops requesting once the frame has arrived', async () => {
    const runtime = sessionFixture();
    mocks.getScreenSession.mockResolvedValue(runtime.session);
    const viewer = sinkFixture();
    await hub.addViewer('sample-browser', viewer.sink);
    const caster = mocks.casters[0]!;
    caster.emit('frame', castFrame(runtime.target.identity));
    const after = Date.now() + 50;
    const target = { page: runtime.target.identity, seq: 2, timestamp: Date.now(), kind: 'input' as const, actor: 'ai' as const,
      x: 130, y: 80, rect: { x: 80, y: 60, width: 100, height: 40 }, scrollX: 0, scrollY: 0, frameAfter: after };
    runtime.emit({ type: 'feedback', pointer: { ...pointer(runtime.target.identity), target } });
    expect(caster.refreshFrame).toHaveBeenCalledOnce();
    caster.emit('frame', { ...castFrame(runtime.target.identity), timestamp: after });
    runtime.emit({ type: 'feedback', pointer: { ...pointer(runtime.target.identity), target } });
    expect(caster.refreshFrame).toHaveBeenCalledOnce();
    runtime.emit({ type: 'feedback', pointer: { ...pointer(runtime.target.identity), positionTarget: { ...target, frameAfter: after + 50 } } });
    expect(caster.refreshFrame).toHaveBeenCalledTimes(2);
    runtime.emit({ type: 'feedback', pointer: { ...pointer(identity(99)), target: { ...target, page: identity(99) } } });
    expect(caster.refreshFrame).toHaveBeenCalledTimes(2);
  });

  it('gets the connected owner before the first viewer and shares frame/pointer replay', async () => {
    const runtime = sessionFixture();
    mocks.getScreenSession.mockResolvedValue(runtime.session);
    const first = sinkFixture();
    const second = sinkFixture();
    await hub.addViewer('sample-browser', first.sink);
    expect(mocks.getScreenSession).toHaveBeenCalledWith('sample-browser');
    expect(mocks.casters[0]!.page).toBe(runtime.target.page);
    runtime.emit({ type: 'pointer', pointer: pointer(runtime.target.identity) });
    mocks.casters[0]!.emit('frame', castFrame(runtime.target.identity));
    await hub.addViewer('sample-browser', second.sink);
    expect(mocks.casters).toHaveLength(1);
    expect(second.messages.map((message) => message.type)).toEqual(['started', 'screen-state', 'frame']);
    expect(second.messages[1]).toMatchObject({ pointer: { x: 80, y: 120 }, page: runtime.target.identity });
    expect(second.messages[2]).toMatchObject({ meta: { page: runtime.target.identity } });
  });

  it('replays the valid current position to a late viewer after 5 seconds without expired press feedback', async () => {
    const runtime = sessionFixture();
    mocks.getScreenSession.mockResolvedValue(runtime.session);
    const first = sinkFixture();
    await hub.addViewer('sample-browser', first.sink);
    const down = pointer(runtime.target.identity, 2, 'down');
    runtime.emit({ type: 'pointer', pointer: down });
    runtime.emit({ type: 'pointer', pointer: pointer(runtime.target.identity, 3, 'up') });
    vi.advanceTimersByTime(6000);
    const late = sinkFixture();
    await hub.addViewer('sample-browser', late.sink);
    expect(late.messages[1]).toMatchObject({ page: runtime.target.identity,
      pointer: { seq: 3, x: down.x, y: down.y, timestamp: down.timestamp, press: undefined } });
    expect(mocks.casters).toHaveLength(1);
  });

  it.each(['first-second', 'second-first'])('shares the first caster across concurrent requests and releases subscriptions in %s order', async (releaseOrder) => {
    const runtime = sessionFixture();
    let connect!: (session: typeof runtime.session) => void;
    mocks.getScreenSession.mockReturnValue(new Promise<typeof runtime.session>((yes) => { connect = yes; }));
    const first = sinkFixture();
    const second = sinkFixture();
    const opening = [hub.addViewer('sample-browser', first.sink), hub.addViewer('sample-browser', second.sink)];
    connect(runtime.session);
    await Promise.all(opening);
    expect(mocks.casters).toHaveLength(1);
    expect(runtime.listeners.size).toBe(1);
    expect(mocks.sessionListeners.size).toBe(1);
    runtime.emit({ type: 'pointer', pointer: pointer(runtime.target.identity) });
    mocks.casters[0]!.emit('frame', castFrame(runtime.target.identity));
    for (const viewer of [first, second]) {
      expect(viewer.messages).toContainEqual(expect.objectContaining({ type: 'screen-state', pointer: expect.objectContaining({ x: 80, y: 120 }) }));
      expect(viewer.messages.at(-1)).toMatchObject({ type: 'frame', meta: { page: runtime.target.identity } });
    }
    const order = releaseOrder === 'first-second' ? [first, second] : [second, first];
    hub.removeViewer('sample-browser', order[0]!.sink);
    expect(runtime.listeners.size).toBe(1);
    expect(mocks.sessionListeners.size).toBe(1);
    hub.removeViewer('sample-browser', order[1]!.sink);
    hub.close();
    expect(runtime.listeners.size).toBe(0);
    expect(mocks.sessionListeners.size).toBe(0);
  });

  it('does not retain a closed initial request while another request awaits the same connection', async () => {
    const runtime = sessionFixture();
    let connect!: (session: typeof runtime.session) => void;
    mocks.getScreenSession.mockReturnValue(new Promise<typeof runtime.session>((yes) => { connect = yes; }));
    const first = sinkFixture();
    const second = sinkFixture();
    const opening = [hub.addViewer('sample-browser', first.sink), hub.addViewer('sample-browser', second.sink)];
    first.close();
    hub.removeViewer('sample-browser', first.sink);
    connect(runtime.session);
    await Promise.all(opening);
    expect(first.messages).toEqual([]);
    expect(mocks.casters).toHaveLength(1);
    mocks.casters[0]!.emit('frame', castFrame(runtime.target.identity));
    expect(second.messages.at(-1)).toMatchObject({ type: 'frame' });
    hub.removeViewer('sample-browser', second.sink);
    expect(runtime.listeners.size).toBe(0);
    expect(mocks.sessionListeners.size).toBe(0);
  });

  it('routes failed shared startup to both concurrent viewers and releases its subscriptions', async () => {
    const runtime = sessionFixture();
    let connect!: (session: typeof runtime.session) => void;
    mocks.getScreenSession.mockReturnValue(new Promise<typeof runtime.session>((yes) => { connect = yes; }));
    mocks.startFailure = new Error('Sample shared startup failure');
    const first = sinkFixture();
    const second = sinkFixture();
    const opening = [hub.addViewer('sample-browser', first.sink), hub.addViewer('sample-browser', second.sink)];
    connect(runtime.session);
    await Promise.all(opening);
    expect(mocks.casters).toHaveLength(1);
    for (const viewer of [first, second]) {
      expect(viewer.messages.at(-1)).toMatchObject({ type: 'error', failure: { code: 'caster-failed', message: 'Sample shared startup failure' } });
    }
    expect(runtime.listeners.size).toBe(0);
    expect(mocks.sessionListeners.size).toBe(0);
  });

  it('resets selection, preserves same-Page observations through navigation and filters old frames/other pages', async () => {
    const runtime = sessionFixture();
    mocks.getScreenSession.mockResolvedValue(runtime.session);
    const first = sinkFixture();
    await hub.addViewer('sample-browser', first.sink);
    const old = runtime.target;
    runtime.emit({ type: 'pointer', pointer: pointer(old.identity) });
    mocks.casters[0]!.emit('frame', castFrame(old.identity));
    const next = { page: {} as BrowserScreenTarget['page'], identity: identity(2) };
    runtime.select(next);
    expect(first.messages.at(-1)).toEqual({ type: 'screen-state', browserId: 'sample-browser', page: next.identity, pointer: null });
    expect(mocks.casters[0]!.rebind).toHaveBeenLastCalledWith(next.page, next.identity);
    const count = first.messages.length;
    runtime.emit({ type: 'pointer', pointer: pointer(old.identity, 2) });
    mocks.casters[0]!.emit('frame', castFrame(old.identity));
    expect(first.messages).toHaveLength(count);
    const lateViewer = sinkFixture();
    await hub.addViewer('sample-browser', lateViewer.sink);
    expect(lateViewer.messages.map((message) => message.type)).toEqual(['started', 'screen-state']);
    runtime.select({ ...next, identity: identity(2, 1) });
    runtime.emit({ type: 'pointer', pointer: pointer(next.identity, 3) });
    expect(first.messages.at(-1)).toMatchObject({ page: identity(2, 1), pointer: { page: next.identity, seq: 3 } });
  });

  it('projects the original observation into a same-Page target without relabeling its origin or replaying a source action', async () => {
    const runtime = sessionFixture();
    mocks.getScreenSession.mockResolvedValue(runtime.session);
    const viewer = sinkFixture();
    await hub.addViewer('sample-browser', viewer.sink);
    const original = runtime.target;
    runtime.emit({ type: 'pointer', pointer: pointer(original.identity, 2, 'down') });
    runtime.emit({ type: 'pointer', pointer: pointer(original.identity, 3, 'up') });
    const before = (viewer.messages.at(-1) as Extract<StreamServerMessage, { type: 'screen-state' }>).pointer;
    const next = { ...original, identity: identity(1, 1) };
    runtime.select(next);
    expect(viewer.messages.at(-1)).toMatchObject({ page: next.identity, pointer: before });
    expect((viewer.messages.at(-1) as Extract<StreamServerMessage, { type: 'screen-state' }>).pointer).toBe(before);
    expect(before).toMatchObject({ page: original.identity, seq: 3, press: { page: original.identity, seq: 2 } });
    const late = sinkFixture();
    await hub.addViewer('sample-browser', late.sink);
    expect(late.messages[1]).toMatchObject({ page: next.identity, pointer: before });
  });

  it('keeps the newest endpoint and a real press when click acknowledgements finish out of order', async () => {
    const runtime = sessionFixture();
    mocks.getScreenSession.mockResolvedValue(runtime.session);
    const viewer = sinkFixture();
    await hub.addViewer('sample-browser', viewer.sink);
    runtime.emit({ type: 'pointer', pointer: pointer(runtime.target.identity, 3, 'up') });
    runtime.emit({ type: 'pointer', pointer: pointer(runtime.target.identity, 2, 'down') });
    expect(viewer.messages.at(-1)).toMatchObject({ pointer: { seq: 3, buttons: 0, press: { seq: 2 } } });
    runtime.emit({ type: 'pointer', pointer: { ...pointer(runtime.target.identity, 1), x: 5 } });
    expect(viewer.messages.at(-1)).toMatchObject({ pointer: { seq: 3, x: 80 } });
  });

  it('keeps a replacement stream when failed startup cleanup of its previous entry finishes late', async () => {
    const runtime = sessionFixture();
    mocks.getScreenSession.mockResolvedValue(runtime.session);
    let finishStop!: () => void;
    mocks.stopWait = new Promise<void>((yes) => { finishStop = yes; });
    mocks.startFailure = new Error('Sample startup failure');
    const first = sinkFixture();
    const opening = hub.addViewer('sample-browser', first.sink);
    await vi.waitFor(() => expect(mocks.casters[0]!.stop).toHaveBeenCalledOnce());
    hub.removeViewer('sample-browser', first.sink);
    const replacement = sinkFixture();
    await hub.addViewer('sample-browser', replacement.sink);
    finishStop();
    await opening;
    mocks.casters[1]!.emit('frame', castFrame(runtime.target.identity));
    expect(replacement.messages.at(-1)).toMatchObject({ type: 'frame', meta: { page: runtime.target.identity } });
    expect(mocks.sessionListeners.size).toBe(1);
  });

  it('does not route late errors from a released caster into a replacement stream', async () => {
    const runtime = sessionFixture();
    mocks.getScreenSession.mockResolvedValue(runtime.session);
    const first = sinkFixture();
    await hub.addViewer('sample-browser', first.sink);
    hub.removeViewer('sample-browser', first.sink);
    const next = sinkFixture();
    await hub.addViewer('sample-browser', next.sink);
    const count = next.messages.length;
    mocks.casters[0]!.emit('error', new Error('Sample late capture failure'));
    expect(next.messages).toHaveLength(count);
  });

  it('follows recovered connections, resets during disconnect and releases observers with the last viewer', async () => {
    const runtime = sessionFixture();
    mocks.getScreenSession.mockResolvedValue(runtime.session);
    const viewer = sinkFixture();
    await hub.addViewer('sample-browser', viewer.sink);
    runtime.emit({ type: 'target', target: null });
    expect(viewer.messages.at(-1)).toMatchObject({ page: null, pointer: null });
    const recovered = sessionFixture(3, 'sample-recovered');
    mocks.getScreenSession.mockResolvedValue(recovered.session);
    for (const listener of mocks.sessionListeners) listener(recovered.session);
    expect(runtime.listeners.size).toBe(0);
    expect(mocks.casters[0]!.rebind).toHaveBeenLastCalledWith(recovered.target.page, recovered.target.identity);
    recovered.emit({ type: 'pointer', pointer: pointer(recovered.target.identity) });
    expect(viewer.messages.at(-1)).toMatchObject({ page: recovered.target.identity, pointer: { x: 80 } });
    hub.removeViewer('sample-browser', viewer.sink);
    expect(recovered.listeners.size).toBe(0);
    expect(mocks.sessionListeners.size).toBe(0);
    const reads = mocks.getScreenSession.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.getScreenSession).toHaveBeenCalledTimes(reads);
  });
});
