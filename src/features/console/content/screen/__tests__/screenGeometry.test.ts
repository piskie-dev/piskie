import { describe, expect, it } from 'vitest';
import { localToPage, pageToLocal } from '../screenGeometry';
import { toPageCoords } from '../remoteInput';

describe('shared screen geometry', () => {
  it('keeps forward and reverse contain mapping aligned through resize and both letterbox directions', () => {
    const frame = { width: 800, height: 600 };
    const point = { x: 250, y: 140 };
    for (const box of [{ width: 800, height: 400 }, { width: 300, height: 600 }, { width: 900, height: 675 }]) {
      const local = pageToLocal(point, box, frame)!;
      const result = localToPage(local, box, frame)!;
      expect(result.x).toBeCloseTo(point.x);
      expect(result.y).toBeCloseTo(point.y);
    }
    expect(pageToLocal({ x: 400, y: 300 }, { width: 800, height: 400 }, frame)).toEqual({ x: 400, y: 200 });
    expect(localToPage({ x: 20, y: 100 }, { width: 800, height: 400 }, frame)).toBeNull();
  });

  it('uses local CSS size for the overlay and physical rect for input under ancestor zoom and local scrolling', () => {
    const frame = { width: 800, height: 600 };
    const box = { width: 500, height: 300 };
    const point = { x: 200, y: 180 };
    const local = pageToLocal(point, box, frame)!;
    for (const zoom of [0.5, 1, 1.75]) {
      const rect = { left: -40, top: 70, width: box.width * zoom, height: box.height * zoom };
      const host = { getBoundingClientRect: () => rect } as HTMLElement;
      const mapped = toPageCoords(host, rect.left + local.x * zoom, rect.top + local.y * zoom, frame)!;
      expect(mapped.x).toBeCloseTo(point.x);
      expect(mapped.y).toBeCloseTo(point.y);
    }
  });

  it('maps CSS coordinates into scaled capture metadata without multiplying bitmap DPR or document scroll', () => {
    const frame = { width: 800, height: 600 };
    expect(pageToLocal({ x: 200, y: 120 }, { width: 400, height: 300 }, frame,
      { scale: 1.25, offsetX: 0, offsetY: 4 })).toEqual({ x: 125, y: 77 });
    expect(pageToLocal({ x: 900, y: 20 }, { width: 400, height: 300 }, frame)).toBeNull();
    expect(pageToLocal({ x: 0, y: 0 }, { width: 0, height: 0 }, frame)).toBeNull();
  });
});
