/**
 * dock 画布布局的单测。
 *
 * 这些数值直接决定视觉，而视觉是本次要复刻的目标（用户 2026-07-31：复刻老版 dock 的
 * 视觉效果）。所以断言写的是**具体坐标**而不是"大于零"——数值漂了要立刻红。
 * 常量来源见 `layout.ts` 文件头（逐条对齐旧 `TREE_LAYOUT` / `LAYOUT`；
 * 例外：worker 估算盒 2026-08-05 起 340→600，随节点加宽，见 `layout.ts` 注释）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildCanvasLayout,
  CANVAS_LAYOUT,
  columnCount,
  laneHeight,
  workerHasScreen,
  type CanvasWorkerInput,
} from '../layout';

function worker(over: Partial<CanvasWorkerInput> & { id: string }): CanvasWorkerInput {
  return { mode: 'browser', browserId: 'b1', ...over };
}

function base(over: Partial<Parameters<typeof buildCanvasLayout>[0]> = {}) {
  return {
    mainAgentId: 'main-1',
    workers: [] as readonly CanvasWorkerInput[],
    includeMain: false,
    ...over,
  };
}

const WORKER_START_X =
  CANVAS_LAYOUT.mainNodeX + CANVAS_LAYOUT.mainNodeWidth + CANVAS_LAYOUT.mainSubGap; // 100+600+160 = 860

const LANE_WIDTH =
  CANVAS_LAYOUT.subNodeWidth + CANVAS_LAYOUT.attachedGap + CANVAS_LAYOUT.screenWidth; // 600+110+280 = 990

const COLUMN_STRIDE = LANE_WIDTH + CANVAS_LAYOUT.subColumnGap; // 990+140 = 1130

describe('能力判据', () => {
  it('有 browserId 且非 local 才有屏幕', () => {
    expect(workerHasScreen(worker({ id: 'w' }))).toBe(true);
    expect(workerHasScreen(worker({ id: 'w', mode: 'local' }))).toBe(false);
    expect(workerHasScreen(worker({ id: 'w', browserId: undefined }))).toBe(false);
  });
});

describe('columnCount 分档', () => {
  it('0/1 个 → 1 列；2–4 个 → 2 列；5+ → 3 列', () => {
    expect(columnCount(0)).toBe(1);
    expect(columnCount(1)).toBe(1);
    expect(columnCount(2)).toBe(2);
    expect(columnCount(4)).toBe(2);
    expect(columnCount(5)).toBe(3);
    expect(columnCount(50)).toBe(3);
  });
});

describe('laneHeight', () => {
  it('取 worker 节点与附属（屏幕）的较高者 —— 880 高的 worker 恒占优', () => {
    // 附属 = screen(220) < subNodeHeight(880)
    expect(laneHeight(worker({ id: 'w' }))).toBe(880);
  });

  it('无屏幕（local）时同样取 worker 高度 880', () => {
    expect(laneHeight(worker({ id: 'w', mode: 'local' }))).toBe(880);
  });
});

describe('buildCanvasLayout · 空与主节点', () => {
  it('无 worker ⇒ 空画布', () => {
    expect(buildCanvasLayout(base())).toEqual({ nodes: [], edges: [] });
  });

  it('includeMain 才出主节点，位置固定在左上', () => {
    const withMain = buildCanvasLayout(base({ includeMain: true }));
    expect(withMain.nodes).toHaveLength(1);
    expect(withMain.nodes[0]).toMatchObject({
      kind: 'main',
      x: CANVAS_LAYOUT.mainNodeX,
      y: CANVAS_LAYOUT.mainNodeStartY,
      width: 600,
      height: 880,
    });
  });

  it('主节点不在画布时，worker 起点仍保留那段留白（不贴固定列右缘）', () => {
    const layout = buildCanvasLayout(base({ workers: [worker({ id: 'w1' })] }));
    expect(layout.nodes.find((n) => n.kind === 'worker')?.x).toBe(WORKER_START_X);
  });

  it('includeMain 时主节点到每个 worker 有一条边', () => {
    const layout = buildCanvasLayout(
      base({ includeMain: true, workers: [worker({ id: 'a' }), worker({ id: 'b' })] }),
    );
    expect(layout.edges.filter((e) => e.source === 'main-main-1').map((e) => e.target).sort()).toEqual([
      'worker-a',
      'worker-b',
    ]);
  });
});

describe('buildCanvasLayout · 单 worker 的一条 lane', () => {
  const layout = buildCanvasLayout(base({ workers: [worker({ id: 'w1' })] }));
  const byKind = (kind: string) => layout.nodes.find((n) => n.kind === kind);

  it('worker 在起点', () => {
    expect(byKind('worker')).toMatchObject({ x: WORKER_START_X, y: 100, width: 600, height: 880 });
  });

  it('屏幕在 worker 右侧、顶部对齐', () => {
    expect(byKind('screen')).toMatchObject({
      ownerId: 'w1',
      x: WORKER_START_X + 600 + 110,
      y: 100,
      width: 280,
      height: 220,
    });
  });

  it('附属边从 worker 指出，不含主节点边（includeMain=false）', () => {
    expect(layout.edges.map((e) => e.id)).toEqual(['worker-w1->screen-w1']);
  });
});

describe('buildCanvasLayout · 装箱', () => {
  it('2 个 worker ⇒ 2 列，第二个在第二列同一行', () => {
    const layout = buildCanvasLayout(base({ workers: [worker({ id: 'a' }), worker({ id: 'b' })] }));
    const workers = layout.nodes.filter((n) => n.kind === 'worker');
    expect(workers.map((n) => n.x)).toEqual([WORKER_START_X, WORKER_START_X + COLUMN_STRIDE]);
    expect(workers.map((n) => n.y)).toEqual([100, 100]);
  });

  it('3 个 worker（2 列）⇒ 第三个回到第一列，y 按 lane 高度累加', () => {
    const layout = buildCanvasLayout(
      base({ workers: [worker({ id: 'a' }), worker({ id: 'b' }), worker({ id: 'c' })] }),
    );
    const third = layout.nodes.filter((n) => n.kind === 'worker')[2]!;
    expect(third.x).toBe(WORKER_START_X);
    expect(third.y).toBe(100 + 880 + CANVAS_LAYOUT.laneGapY);
  });

  it('5 个 worker ⇒ 3 列', () => {
    const layout = buildCanvasLayout(
      base({ workers: ['a', 'b', 'c', 'd', 'e'].map((id) => worker({ id })) }),
    );
    const xs = new Set(layout.nodes.filter((n) => n.kind === 'worker').map((n) => n.x));
    expect(xs.size).toBe(3);
  });
});

describe('buildCanvasLayout · 节点 id 唯一', () => {
  it('大量 worker 下节点与边的 id 不冲突', () => {
    const layout = buildCanvasLayout(
      base({
        includeMain: true,
        workers: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => worker({ id })),
      }),
    );
    const ids = layout.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    const edgeIds = layout.edges.map((e) => e.id);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
  });
});
