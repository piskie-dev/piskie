/**
 * FlowEdge —— dock 画布的连线。
 *
 * ## 形态
 *
 * 路径用 `getSmoothStepPath` 并显式给参数 —— **内建 `smoothstep` 的默认圆角只有 5**，
 * 转折生硬，两条从同一锚点出发的边挤在一起就显得乱：
 *
 * | 参数 | 值 |
 * |---|---|
 * | `borderRadius` | 22 |
 * | `offset` | 22 |
 * | `stepPosition` | 0.5 |
 *
 * 描边是**四层叠加**，缺任何一层都不是那个"电路走线"的质感：
 *
 * | 层 | 作用 |
 * |---|---|
 * | halo | 6px 极淡白 + 外发光，给线一点体积 |
 * | rail | 1.55px 主体 |
 * | inner | 0.75px 更淡的芯线 |
 * | glow | 2.5px，**描边是动画渐变**，形成沿线游走的高光 |
 *
 * ## 动画怎么做的
 *
 * 不是 dash offset，而是**让 linearGradient 的两个端点沿边的方向平移**
 * （SVG `<animate>` 驱动 x1/y1/x2/y2，2.2s 循环）。渐变本身是"透明 → 亮 → 透明"，
 * 端点移动时那段亮部就沿线跑。用 `gradientUnits="userSpaceOnUse"` 才能按画布坐标算。
 *
 * 色值全部落在 CSS（含 SVG 的 `stop-color`），TSX 里零色值 —— `check:styles` 的要求。
 */

import { memo, useId } from 'react';
import { getSmoothStepPath, type EdgeProps } from '@xyflow/react';

import styles from './flowEdge.module.css';

/** 改这三个数会直接改变走线观感 */
const PATH_OPTIONS = { borderRadius: 22, offset: 22, stepPosition: 0.5 } as const;

/** 高光循环周期 */
const TRAVEL_DURATION = '2.2s';

/** SVG id 不能含特殊字符，react-flow 的边 id 里有 `->` */
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function round(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0';
}

/**
 * 算出渐变端点的起止位置：沿边的方向，从"边之前一段"平移到"边之后一段"，
 * 这样亮部是从源头进入、从末端离开，而不是在中间凭空出现。
 */
function travel(sourceX: number, sourceY: number, targetX: number, targetY: number) {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.max(Math.hypot(dx, dy), 1);
  const ux = dx / length;
  const uy = dy / length;

  // 亮部长度随边长走，但夹在 [120, 360]：太短看不见，太长就整条线都在亮
  const half = Math.min(360, Math.max(120, length * 0.48));
  const pad = half * 1.15;

  const from = { x: sourceX - ux * pad, y: sourceY - uy * pad };
  const to = { x: targetX + ux * pad, y: targetY + uy * pad };

  return {
    x1: `${round(from.x - ux * half)};${round(to.x - ux * half)}`,
    y1: `${round(from.y - uy * half)};${round(to.y - uy * half)}`,
    x2: `${round(from.x + ux * half)};${round(to.x + ux * half)}`,
    y2: `${round(from.y + uy * half)};${round(to.y + uy * half)}`,
  };
}

const FlowEdge = memo<EdgeProps>(
  ({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, interactionWidth = 20 }) => {
    // `useId` 保证同一条边在多实例下也不撞
    const gradientId = `dock-flow-${sanitize(id)}-${sanitize(useId())}`;
    const motion = travel(sourceX, sourceY, targetX, targetY);

    const [path] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      ...PATH_OPTIONS,
    });

    const firstOf = (values: string) => values.split(';')[0] ?? '0';

    return (
      <>
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1={firstOf(motion.x1)}
            y1={firstOf(motion.y1)}
            x2={firstOf(motion.x2)}
            y2={firstOf(motion.y2)}
          >
            <stop offset="0%" className={styles.stopEdge} />
            <stop offset="25%" className={styles.stopSoft} />
            <stop offset="50%" className={styles.stopPeak} />
            <stop offset="75%" className={styles.stopSoft} />
            <stop offset="100%" className={styles.stopEdge} />
            <animate attributeName="x1" dur={TRAVEL_DURATION} repeatCount="indefinite" values={motion.x1} />
            <animate attributeName="y1" dur={TRAVEL_DURATION} repeatCount="indefinite" values={motion.y1} />
            <animate attributeName="x2" dur={TRAVEL_DURATION} repeatCount="indefinite" values={motion.x2} />
            <animate attributeName="y2" dur={TRAVEL_DURATION} repeatCount="indefinite" values={motion.y2} />
          </linearGradient>
        </defs>

        {/* id 挂在第一层：react-flow 的一些工具按 id 找 path */}
        <path id={id} d={path} fill="none" className={styles.halo} data-selected={selected ? 'true' : undefined} />
        <path d={path} fill="none" className={styles.rail} data-selected={selected ? 'true' : undefined} />
        <path d={path} fill="none" className={styles.inner} />
        <path d={path} fill="none" stroke={`url(#${gradientId})`} className={styles.glow} />

        {/* 命中区：加宽不可见描边，否则 1.55px 的线几乎点不到 */}
        {interactionWidth > 0 && (
          <path
            d={path}
            fill="none"
            strokeOpacity={0}
            strokeWidth={interactionWidth}
            className="react-flow__edge-interaction"
          />
        )}
      </>
    );
  },
);

FlowEdge.displayName = 'FlowEdge';

/** 传给 react-flow 的 edgeTypes；**必须是模块级常量**，否则每次渲染都重建边 */
export const CANVAS_EDGE_TYPES = { flow: FlowEdge } as const;
