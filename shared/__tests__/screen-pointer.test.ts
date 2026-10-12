import { describe, expect, it } from 'vitest';
import { reduceScreenPointer, screenPointerPosition } from '../screen-pointer.js';
import type { ScreenElementTarget, ScreenPointer } from '../types/stream.js';

const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
const position: ScreenElementTarget = { page, seq: 2, timestamp: 200, kind: 'input', actor: 'ai',
  x: 130, y: 80, rect: { x: 80, y: 60, width: 100, height: 40 }, scrollX: 0, scrollY: 0 };
const initial: ScreenPointer = { page, seq: 0, timestamp: 10, origin: 'initial', action: 'initialize',
  x: 24, y: 24, buttons: 0, clickCount: 0 };
const manual: ScreenPointer = { page, seq: 1, sourceOrder: 1, timestamp: 100, origin: 'mouse', actor: 'manual',
  action: 'move', x: 650, y: 300, buttons: 0, clickCount: 0 };

describe('screen pointer acknowledgement order', () => {
  it.each(['target', 'positionTarget'] as const)('keeps the newer %s while accepting original older Mouse source fields', (field) => {
    const previous = { ...initial, [field]: position };
    const result = reduceScreenPointer(previous, manual);
    expect(result[field]).toBe(position);
    expect(result).toMatchObject(manual);
    // The displayed position is independent from the authentic Mouse observation.
    expect(screenPointerPosition(result)).toEqual({ ...position });
    expect(result.x).toBe(650);
    expect(result.y).toBe(300);
  });
  it('lets an actually later Mouse input replace a restored element position', () => {
    const result = reduceScreenPointer({ ...manual, positionTarget: position }, { ...manual, seq: 2, sourceOrder: 3, timestamp: 300, x: 500, y: 240 });
    expect(result.positionTarget).toBeUndefined();
    expect(screenPointerPosition(result)).toMatchObject({ x: 500, y: 240 });
  });
  it('retains a newer position on reverse Mouse ACKs and preserves the actual earlier down origin', () => {
    const positionTarget = { ...position, seq: 4 };
    const released = { ...manual, seq: 3, sourceOrder: 3, timestamp: 300, action: 'up' as const, x: 600, y: 240 };
    const result = reduceScreenPointer({ ...released, positionTarget }, { ...manual, seq: 2, sourceOrder: 2, action: 'down', timestamp: 200, buttons: 1, clickCount: 1 });
    expect(result).toMatchObject({ ...released, positionTarget, press: { page, seq: 2, order: 2, x: 650, y: 300, timestamp: 200, actor: 'manual' } });
    expect(screenPointerPosition(result)).toBe(positionTarget);
  });
  it('does not transfer a retained element position to another Page owner', () => {
    const observed = { ...manual, page: { ...page, pageId: 2 } };
    expect(reduceScreenPointer({ ...initial, positionTarget: position }, observed).positionTarget).toBeUndefined();
  });
});
