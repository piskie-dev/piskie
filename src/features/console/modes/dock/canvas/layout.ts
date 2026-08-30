/**
 * dock 画布的布局计算 —— 纯函数，零 React，零 react-flow 依赖。
 *
 * ## 背景
 *
 * dock 的右侧区域是一块可拖拽缩放的画布，**未选中的 worker 连同它的执行流水、
 * 屏幕全都铺在那里**，不点就能看到。
 *
 * ## 算法：按 lane 装箱
 *
 * 一条 **lane** = 一个 worker 节点 + 它右侧的附属（屏幕）。
 * 列数按 worker 数分档（1 / 2 / 3），每个 worker 放进**当前最短的那一列**，
 * 列高按该 lane 的实际高度累加。这样 worker 多时不会无限向右延伸。
 *
 * 主 agent 节点在最左侧固定位置，不参与装箱：dock 模式下主 agent 是固定面板，
 * 画布里的主节点只在多 agent 场景出现，两处复用同一份位置常量。
 */

// ==================== 常量 ====================

/**
 * 排布用的盒子与间距。
 *
 * ⚠️ **这里的 width/height 不是节点的渲染尺寸**，只是算位置用的估算盒——
 * 本文件只出位置，节点多大由组件自己决定（渲染尺寸见 `node-metrics.ts` 的 `NODE_SIZE`）。
 * 估算盒可以比渲染尺寸略大，那是留给间距的余量。
 */
export const CANVAS_LAYOUT = {
  /**
   * - 宽 600 = `nodes.tsx` 的 worker 渲染宽 560 + 40 余量；改渲染宽要同步这里。
   * - 高 880 必须 **≥ 真实渲染高**，装箱才成立：估算高偏小时，同列第二条 lane 的 y
   *   会按小值步进，3+ worker 触发同列堆叠时节点直接重叠。
   */
  mainNodeWidth: 600,
  mainNodeHeight: 880,
  subNodeWidth: 600,
  subNodeHeight: 880,
  screenWidth: 280,
  screenHeight: 220,
  /** 主节点与 worker 区之间的横向留白 */
  mainSubGap: 160,
  /** worker 节点与它的附属之间的横向留白 */
  attachedGap: 110,
  /** 相邻 worker 列之间的留白 */
  subColumnGap: 140,
  /** 同一列内相邻 lane 的纵向留白 */
  laneGapY: 140,
  mainNodeX: 100,
  mainNodeStartY: 100,
} as const;

// ==================== 输入 ====================

/** 布局只需要这些字段——收窄入参，不让布局层依赖控制态全量类型 */
export interface CanvasWorkerInput {
  readonly id: string;
  readonly mode: string;
  readonly browserId?: string;
}

export interface CanvasLayoutInput {
  readonly mainAgentId: string;
  readonly workers: readonly CanvasWorkerInput[];
  /** 是否把主 agent 节点也放进画布（dock 模式里主 agent 在固定列，故传 false） */
  readonly includeMain: boolean;
}

// ==================== 输出 ====================

export type CanvasNodeKind = 'main' | 'worker' | 'screen';

export interface CanvasNode {
  readonly id: string;
  readonly kind: CanvasNodeKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** worker / screen 都指向所属 worker */
  readonly ownerId: string;
}

export interface CanvasEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface CanvasLayout {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
}

// ==================== 判据 ====================

/** 有浏览器且非 local 才有屏幕 */
export function workerHasScreen(worker: CanvasWorkerInput): boolean {
  return !!worker.browserId && worker.mode !== 'local';
}

/** lane 主体高度：worker 节点与附属（屏幕）取较高者 */
function laneBaseHeight(worker: CanvasWorkerInput): number {
  const attached = workerHasScreen(worker) ? CANVAS_LAYOUT.screenHeight : 0;
  return Math.max(CANVAS_LAYOUT.subNodeHeight, attached);
}

/** 一条 lane 的总高度 */
export function laneHeight(worker: CanvasWorkerInput): number {
  return laneBaseHeight(worker);
}

/** 列数分档 */
export function columnCount(workerCount: number): number {
  if (workerCount <= 1) return 1;
  if (workerCount <= 4) return 2;
  return 3;
}

// ==================== 出口 ====================

export function buildCanvasLayout(input: CanvasLayoutInput): CanvasLayout {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  const laneWidth =
    CANVAS_LAYOUT.subNodeWidth + CANVAS_LAYOUT.attachedGap + CANVAS_LAYOUT.screenWidth;
  const columnStride = laneWidth + CANVAS_LAYOUT.subColumnGap;

  const mainNodeId = `main-${input.mainAgentId}`;

  if (input.includeMain) {
    nodes.push({
      id: mainNodeId,
      kind: 'main',
      x: CANVAS_LAYOUT.mainNodeX,
      y: CANVAS_LAYOUT.mainNodeStartY,
      width: CANVAS_LAYOUT.mainNodeWidth,
      height: CANVAS_LAYOUT.mainNodeHeight,
      ownerId: input.mainAgentId,
    });
  }

  /**
   * worker 区的起点。**主节点不在画布时也保留这段偏移**：dock 模式下主 agent 是左侧
   * 固定列，画布从它右边开始，留白语义一致（否则 worker 会贴着固定列的右边缘）。
   */
  const workerStartX =
    CANVAS_LAYOUT.mainNodeX + CANVAS_LAYOUT.mainNodeWidth + CANVAS_LAYOUT.mainSubGap;

  const columns = columnCount(input.workers.length);
  const columnHeights: number[] = Array.from(
    { length: Math.max(columns, 1) },
    () => CANVAS_LAYOUT.mainNodeStartY,
  );

  for (const worker of input.workers) {
    // 放进当前最短的一列
    let target = 0;
    for (let index = 1; index < columnHeights.length; index += 1) {
      if (columnHeights[index]! < columnHeights[target]!) target = index;
    }

    const x = workerStartX + target * columnStride;
    const y = columnHeights[target]!;
    const workerNodeId = `worker-${worker.id}`;

    nodes.push({
      id: workerNodeId,
      kind: 'worker',
      x,
      y,
      width: CANVAS_LAYOUT.subNodeWidth,
      height: CANVAS_LAYOUT.subNodeHeight,
      ownerId: worker.id,
    });

    if (input.includeMain) {
      edges.push({ id: `${mainNodeId}->${workerNodeId}`, source: mainNodeId, target: workerNodeId });
    }

    const attachedX = x + CANVAS_LAYOUT.subNodeWidth + CANVAS_LAYOUT.attachedGap;

    if (workerHasScreen(worker)) {
      const id = `screen-${worker.id}`;
      nodes.push({
        id,
        kind: 'screen',
        // 屏幕是 worker 的唯一附属，与 worker 顶部对齐
        x: attachedX,
        y,
        width: CANVAS_LAYOUT.screenWidth,
        height: CANVAS_LAYOUT.screenHeight,
        ownerId: worker.id,
      });
      edges.push({ id: `${workerNodeId}->${id}`, source: workerNodeId, target: id });
    }

    columnHeights[target] = y + laneHeight(worker) + CANVAS_LAYOUT.laneGapY;
  }

  return { nodes, edges };
}
