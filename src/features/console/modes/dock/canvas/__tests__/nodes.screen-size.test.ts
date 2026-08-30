import { describe, expect, it } from 'vitest';
import { NODE_SIZE, screenAutoSize } from '../node-metrics';

describe('screenAutoSize(屏幕节点默认尺寸跟随真实视口比例)', () => {
  it('首帧未到(null)按 16:10 兜底', () => {
    const size = screenAutoSize(null);
    expect(size.width).toBe(NODE_SIZE.screen.width);
    expect(size.height).toBe(Math.round(2 + (640 - 2) / (16 / 10)));
  });

  it('横屏视口:定宽,画面区比例=真实比例(壳仅加 2px 边框)', () => {
    const size = screenAutoSize(16 / 9);
    expect(size.width).toBe(640);
    expect(size.height).toBe(Math.round(2 + (640 - 2) / (16 / 9)));
    // 画面区(扣 chrome)的比例与输入一致
    expect((size.width - 2) / (size.height - 2)).toBeCloseTo(16 / 9, 1);
  });

  it('方形与 4:3 视口仍在封顶内', () => {
    expect(screenAutoSize(4 / 3).height).toBe(Math.round(2 + 638 / (4 / 3)));
    expect(screenAutoSize(1).height).toBe(640);
  });

  it('竖屏视口:封顶高度,按比例反向收窄宽度', () => {
    const size = screenAutoSize(9 / 16);
    expect(size.height).toBe(NODE_SIZE.screen.maxAutoHeight);
    expect(size.width).toBe(Math.round(2 + (NODE_SIZE.screen.maxAutoHeight - 2) * (9 / 16)));
  });

  it('极端窄比例不低于手调下限宽度', () => {
    const size = screenAutoSize(0.2);
    expect(size.width).toBeGreaterThanOrEqual(320);
    expect(size.height).toBe(NODE_SIZE.screen.maxAutoHeight);
  });
});
