import { describe, expect, it, vi } from 'vitest';
import type { Mouse, MouseClickOptions } from 'puppeteer-core';
import { MouseObserver, type ObservedMouseAction } from '../mouse-observer.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mouseFixture() {
  const calls: Array<{ method: string; args: unknown[]; receiver: unknown }> = [];
  const pending: ReturnType<typeof deferred>[] = [];
  const mouse = {
    move(this: unknown, ...args: unknown[]) { return operation('move', this, args); },
    down(this: unknown, ...args: unknown[]) { return operation('down', this, args); },
    up(this: unknown, ...args: unknown[]) { return operation('up', this, args); },
    // The installed public click calls all these methods before Promise.all settles.
    async click(this: Mouse, x: number, y: number, options: MouseClickOptions = {}) {
      const actions = [this.move(x, y)];
      for (let i = 1; i <= (options.count ?? 1); i++) {
        const pressOptions = { ...options, clickCount: i };
        actions.push(this.down(pressOptions), this.up(pressOptions));
      }
      await Promise.all(actions);
    },
  } as unknown as Mouse;
  function operation(method: string, receiver: unknown, args: unknown[]) {
    calls.push({ method, args, receiver });
    const next = deferred();
    pending.push(next);
    return next.promise;
  }
  const observed: Array<{ page: string; action: ObservedMouseAction }> = [];
  let page = 'sample-page';
  const original = { move: mouse.move, down: mouse.down, up: mouse.up };
  const observer = new MouseObserver(mouse, () => page, (binding, action) => observed.push({ page: binding, action }));
  return { mouse, calls, pending, observed, original, observer, setPage: (next: string) => { page = next; } };
}

async function settle(test: ReturnType<typeof mouseFixture>) {
  for (const next of test.pending) next.resolve();
  await Promise.all(test.pending.map((next) => next.promise));
}

describe('MouseObserver public execution boundary', () => {
  it('preserves arguments, receiver and exact promise; publishes only after success with call-time binding', async () => {
    const test = mouseFixture();
    const options = { steps: 4 };
    const promise = test.mouse.move(23.5, 71.25, options);
    expect(promise).toBe(test.pending[0]!.promise);
    expect(test.calls).toEqual([{ method: 'move', args: [23.5, 71.25, options], receiver: test.mouse }]);
    expect(test.observed).toEqual([]);
    test.setPage('sample-next-page');
    await settle(test);
    expect(test.observed).toEqual([{ page: 'sample-page', action: expect.objectContaining({ action: 'move', x: 23.5, y: 71.25, buttons: 0 }) }]);
  });

  it('observes concurrent double-click press/release coordinates without serializing the public click', async () => {
    const test = mouseFixture();
    const click = test.mouse.click(250, 160, { count: 2, button: 'right' as never });
    expect(test.calls.map((call) => call.method)).toEqual(['move', 'down', 'up', 'down', 'up']);
    expect(test.pending).toHaveLength(5);
    await settle(test);
    await click;
    expect(test.observed.map(({ action }) => [action.seq, action.action, action.x, action.y, action.buttons, action.clickCount])).toEqual([
      [1, 'move', 250, 160, 0, 0], [2, 'down', 250, 160, 2, 1], [3, 'up', 250, 160, 0, 1],
      [4, 'down', 250, 160, 2, 2], [5, 'up', 250, 160, 0, 2],
    ]);
  });

  it('keeps call sequence when acknowledgements finish out of order and rolls back failed observations', async () => {
    const test = mouseFixture();
    const first = test.mouse.move(10, 20);
    const second = test.mouse.move(80, 90);
    test.pending[1]!.resolve();
    await second;
    test.pending[0]!.resolve();
    await first;
    expect(test.observed.map(({ action }) => action.seq)).toEqual([2, 1]);
    const failure = new Error('Sample CDP failure');
    const failed = test.mouse.move(400, 500);
    const check = expect(failed).rejects.toBe(failure);
    test.pending[2]!.reject(failure);
    await check;
    const down = test.mouse.down();
    test.pending[3]!.resolve();
    await down;
    // The mouse's own transactions can commit in completion order.
    expect(test.observed.at(-1)?.action).toMatchObject({ action: 'down', x: 10, y: 20, buttons: 1 });
    expect(test.observed).toHaveLength(3);
  });

  it('tracks ordinary drag movement and releases at its last successful endpoint', async () => {
    const test = mouseFixture();
    for (const operation of [() => test.mouse.move(30, 40), () => test.mouse.down(),
      () => test.mouse.move(90, 110, { steps: 5 }), () => test.mouse.up()]) {
      const result = operation();
      test.pending.at(-1)!.resolve();
      await result;
    }
    expect(test.observed.map(({ action }) => [action.action, action.x, action.y, action.buttons])).toEqual([
      ['move', 30, 40, 0], ['down', 30, 40, 1], ['move', 90, 110, 1], ['up', 90, 110, 0],
    ]);
  });

  it('has no invented initial position or internal stepped-move coordinates', async () => {
    const test = mouseFixture();
    const unknownDown = test.mouse.down();
    test.pending[0]!.resolve();
    await unknownDown;
    const move = test.mouse.move(120, 80, { steps: 8 });
    const unknownUp = test.mouse.up();
    test.pending[2]!.resolve();
    await unknownUp;
    expect(test.observed).toEqual([]);
    test.pending[1]!.resolve();
    await move;
    expect(test.observed).toHaveLength(1);
    expect(test.observed[0]!.action).toMatchObject({ action: 'move', x: 120, y: 80 });
  });

  it('keeps the last known position after a zero-step no-op and omits unknown fractional endpoints', async () => {
    const test = mouseFixture();
    const move = test.mouse.move(40, 60);
    test.pending[0]!.resolve(); await move;
    const noop = test.mouse.move(100, 200, { steps: 0 });
    test.pending[1]!.resolve(); await noop;
    const down = test.mouse.down();
    test.pending[2]!.resolve(); await down;
    expect(test.observed.at(-1)?.action).toMatchObject({ action: 'down', x: 40, y: 60 });
    const count = test.observed.length;
    const fractional = test.mouse.move(500, 600, { steps: 1.5 });
    test.pending[3]!.resolve(); await fractional;
    const up = test.mouse.up();
    test.pending[4]!.resolve(); await up;
    expect(test.observed).toHaveLength(count);
  });

  it('dates a successful stepped endpoint when the movement finishes rather than when it starts', async () => {
    const test = mouseFixture();
    let now = 10;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const result = test.mouse.move(100, 200, { steps: 5 });
      now = 200;
      test.pending[0]!.resolve(); await result;
      expect(test.observed[0]?.action.timestamp).toBe(200);
    } finally { clock.mockRestore(); }
  });

  it('restores own descriptors, inherited methods and ignores completion after disposal', async () => {
    const test = mouseFixture();
    const result = test.mouse.move(10, 20);
    test.observer.dispose();
    test.observer.dispose();
    expect(test.mouse.move).toBe(test.original.move);
    expect(test.mouse.down).toBe(test.original.down);
    expect(test.mouse.up).toBe(test.original.up);
    test.pending[0]!.resolve();
    await result;
    expect(test.observed).toEqual([]);
    const base = { move: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}) };
    const inherited = Object.create(base) as Mouse;
    const observer = new MouseObserver(inherited, () => 'sample', vi.fn());
    observer.dispose();
    expect(Object.hasOwn(inherited, 'move')).toBe(false);
    expect(inherited.move).toBe(base.move);
  });

  it('preserves synchronous throws and isolates a throwing telemetry consumer', async () => {
    const failure = new Error('Sample synchronous failure');
    const mouse = { move: () => { throw failure; }, down: async () => {}, up: async () => {} } as unknown as Mouse;
    new MouseObserver(mouse, () => 'sample', () => { throw new Error('Sample consumer failure'); });
    expect(() => mouse.move(1, 2)).toThrow(failure);
    const test = mouseFixture();
    test.observer.dispose();
    new MouseObserver(test.mouse, () => 'sample', () => { throw new Error('Sample consumer failure'); });
    const result = test.mouse.move(1, 2);
    test.pending[0]!.resolve();
    await expect(result).resolves.toBeUndefined();
  });
});
