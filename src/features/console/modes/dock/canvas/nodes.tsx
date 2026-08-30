/**
 * dock 画布的节点：agent / screen 两类，内部一律是 `content/` 与 `modes/dock/`
 * 的常规组件。
 *
 * ## 为什么包装层这么薄
 *
 * 被包的组件**自己就带外框**（`Panel.module.css` 的 2px 边框 + 12px 圆角），
 * 所以节点包装层只负责三件事：
 *
 * 1. 给出**节点自己的**渲染尺寸（常量与纯计算在 `node-metrics.ts`）
 * 2. 挂 `Handle` —— 连线的锚点。**必须存在且不可见**：react-flow 靠它定位边的端点，
 *    没有 Handle 的节点，边会画到节点中心去
 * 3. 选中态的描边
 *
 * ## 尺寸从哪来
 *
 * **渲染尺寸只由 `node-metrics.ts` 的 `NODE_SIZE` 决定**；`layout.ts` 那份常量只算位置与间距，
 * 拿它当节点尺寸套上去会让每个节点都错位。
 *
 * ## 数据订阅
 *
 * 每个节点**自己订阅自己那一片**（`DockPanel` 内部已经是窄订阅）。不由画布统一取数
 * 再往下传：那样任一 worker 的流水变动都会重渲染整块画布。
 */

import { memo, useState } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';

import { BrowserScreenView } from '../../../content/ScreenView';
import { useImageNodes } from '../../../data/useImageNodes';
import { DockPanel } from '../DockPanel';
import { NODE_SIZE, SCREEN_MIN, screenAutoSize } from './node-metrics';
import styles from './canvas.module.css';

/** 节点的公共外壳：定尺 + 连线锚点 + 选中描边 */
const NodeShell = memo<{
  readonly width: number;
  readonly height: number;
  readonly selected?: boolean;
  /** 主节点没有入边 */
  readonly hasTarget?: boolean;
  /** 叶子节点（屏幕）没有出边 */
  readonly hasSource?: boolean;
  readonly children: React.ReactNode;
}>(({ width, height, selected, hasTarget = true, hasSource = false, children }) => (
  <div
    className={styles.node}
    data-selected={selected ? 'true' : undefined}
    style={{ inlineSize: width, blockSize: height }}
  >
    {/* handle 带 id：边显式指定 `sourceHandle: 'right'` / `targetHandle: 'left'` */}
    {hasTarget && <Handle id="left" type="target" position={Position.Left} className={styles.handle} />}
    {children}
    {hasSource && <Handle id="right" type="source" position={Position.Right} className={styles.handle} />}
  </div>
));

NodeShell.displayName = 'CanvasNodeShell';

// ==================== 各类节点的数据契约 ====================

export interface AgentNodeData {
  readonly agentId: string;
  /** 有值即 worker 节点 */
  readonly workerId?: string;
  readonly devMode?: boolean;
  readonly onPreviewImage?: (src: string) => void;
}

export interface ScreenNodeData {
  readonly subagentId: string;
  readonly browserId: string;
  readonly browserReady: boolean;
  readonly title?: string;
  readonly onFullscreen?: () => void;
}

// ==================== 节点组件 ====================

/**
 * 主 / worker 节点。内部是完整的 `DockPanel`（状态条 / 头部 / 流水 / 任务清单 / 输入框），
 * 与左侧固定列用的是**同一个组件** —— 画布上的 worker 也能直接发消息。
 */
const AgentCanvasNode = memo(({ data, selected }: NodeProps) => {
  const node = data as unknown as AgentNodeData;
  const imageNodes = useImageNodes(node.agentId, node.workerId);
  return (
    <NodeShell
      width={NODE_SIZE.worker.width}
      height={NODE_SIZE.worker.height}
      selected={selected}
      hasTarget={!!node.workerId}
      hasSource
    >
      <DockPanel
        agentId={node.agentId}
        workerId={node.workerId}
        fidelity="visible"
        devMode={node.devMode}
        imageNodes={imageNodes}
        onPreviewImage={node.onPreviewImage}
      />
    </NodeShell>
  );
});

AgentCanvasNode.displayName = 'AgentCanvasNode';

const ScreenCanvasNode = memo(({ data, selected }: NodeProps) => {
  const node = data as unknown as ScreenNodeData;
  /** 流上报的真实视口宽高比;首帧前为 null,按 16:10 兜底 */
  const [streamRatio, setStreamRatio] = useState<number | null>(null);
  /**
   * 用户经 NodeResizer 手调过的尺寸;有值后自动比例不再覆盖。
   * ⚠️ 不能用 NodeProps 的 width/height 判定"手调过":react-flow 传的是
   * `measured ?? width ?? initialWidth`——首次测量后永远有值(回显上次渲染尺寸),
   * 拿它当渲染输入会把尺寸锁死在初值,流比例永远进不去。
   */
  const [userSize, setUserSize] = useState<{ width: number; height: number } | null>(null);
  const auto = screenAutoSize(streamRatio);
  const nodeWidth = userSize?.width ?? auto.width;
  const nodeHeight = userSize?.height ?? auto.height;

  return (
    <NodeShell width={nodeWidth} height={nodeHeight} selected={selected}>
      <NodeResizer
        isVisible={selected}
        minWidth={SCREEN_MIN.width}
        minHeight={SCREEN_MIN.height}
        lineClassName={styles.resizeLine}
        handleClassName={styles.resizeHandle}
        onResize={(_, params) => setUserSize({ width: params.width, height: params.height })}
      />
      <BrowserScreenView
        subagentId={node.subagentId}
        browserId={node.browserId}
        browserReady={node.browserReady}
        title={node.title}
        onFullscreen={node.onFullscreen}
        onFrameRatio={setStreamRatio}
      />
    </NodeShell>
  );
});

ScreenCanvasNode.displayName = 'ScreenCanvasNode';

/** 传给 react-flow 的 nodeTypes；**必须是模块级常量**，否则每次渲染都重建节点 */
export const CANVAS_NODE_TYPES = {
  agent: AgentCanvasNode,
  screen: ScreenCanvasNode,
} as const;
