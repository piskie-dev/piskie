/**
 * DockCanvas —— dock 右侧的节点画布。
 *
 * ## 定位
 *
 * **未选中的 worker 连同它的屏幕**全铺在这块画布上，不点就能看到。
 * 节点内部是常规组件（`nodes.tsx`）。
 *
 * ## 与 thread 的隔离
 *
 * `@xyflow/react` 在 `.eslintrc.cjs` 里**只对 `modes/dock/**` 放开**，thread 侧禁用 ——
 * 模式互不参照。
 *
 * ## 交互
 *
 * | 能力 | 参数 |
 * |---|---|
 * | 缩放 | 0.2× – 2×，滚轮 / 捏合 |
 * | 平移 | 拖拽空白 / 滚动 |
 * | 节点 | 可拖动、可选中；**不可连线**（`nodesConnectable={false}`） |
 * | 删除键 | 禁用（`deleteKeyCode={null}`）—— 画布上删不掉 agent |
 * | 小地图 | 可拖可缩放，按节点类型着色 |
 * | 工具栏 | 整理画布 / 放大 / 缩小 |
 *
 * **工具栏没有「切换为树状布局」**：没有树状模式，造一个按钮指向不存在的模式是假功能。
 */

import React, { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
/**
 * react-flow 基础样式表**必须由本文件自己引**：面板/小地图/边的定位全靠它。
 * 少了它，小地图会塌成画布顶部的通栏块（position 回落 static）。
 */
import '@xyflow/react/dist/style.css';
import { Minus, Plus, Sparkles } from 'lucide-react';

import { Tooltip } from '../../../chrome/Tooltip';
import type { ScreenFullscreenTarget } from '../../../content/ScreenFullscreen';
import { buildCanvasLayout, type CanvasNode, type CanvasWorkerInput } from './layout';
import { CANVAS_EDGE_TYPES } from './FlowEdge';
import { CANVAS_NODE_TYPES } from './nodes';
import { NODE_SIZE, screenAutoSize } from './node-metrics';
import type { CanvasWorker } from './useCanvasWorkers';
import styles from './canvas.module.css';

/** 缩放区间 */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;

export interface DockCanvasProps {
  readonly agentId: string;
  /** 画布上要显示的 worker（已扣掉在固定列里显示的那个） */
  readonly workers: readonly CanvasWorker[];
  /** 主 agent 是否在停止中 —— 决定屏幕流是否订阅实时 */
  readonly stopping: boolean;
  readonly devMode?: boolean;
  readonly onPreviewImage?: (src: string) => void;
  readonly onFullscreen?: (target: ScreenFullscreenTarget) => void;
  /** 全部 worker 都在固定列里时的提示文案 */
  readonly emptyHint: string;
}

/**
 * 各类节点的初始尺寸提示。与 `NODE_SIZE`（真实渲染尺寸）保持一致
 * （提示只影响首次测量前的占位）。
 */
function initialSizeOf(kind: CanvasNode['kind']): { width: number; height: number } {
  switch (kind) {
    case 'screen':
      // 首帧未到时的兜底比例;真实比例由节点自己跟流(nodes.tsx screenAutoSize)
      return screenAutoSize(null);
    default:
      return { ...NODE_SIZE.worker };
  }
}

function toWorkerInput(worker: CanvasWorker): CanvasWorkerInput {
  return {
    id: worker.id,
    mode: worker.mode,
    browserId: worker.browserId,
  };
}

const Inner = memo<DockCanvasProps>(
  ({
    agentId,
    workers,
    stopping,
    devMode,
    onPreviewImage,
    onFullscreen,
    emptyHint,
  }) => {
    const { t } = useTranslation();
    const surfaceRef = useRef<HTMLDivElement>(null);
    const { zoomIn, zoomOut, fitView } = useReactFlow();

    /** 布局是纯函数产物；react-flow 需要的形状在这里一次性映射 */
    const layout = useMemo(
      () =>
        buildCanvasLayout({
          mainAgentId: agentId,
          workers: workers.map(toWorkerInput),
          // dock 模式下主 agent 是左侧固定列，画布上不再放一份
          includeMain: false,
        }),
      [agentId, workers],
    );

    const byId = useMemo(() => new Map(workers.map((worker) => [worker.id, worker])), [workers]);

    const toFlowNode = useCallback(
      (node: CanvasNode): Node | null => {
        /**
         * `initialWidth/initialHeight` 是**测量前的尺寸提示**：react-flow 在
         * ResizeObserver 量到真实尺寸之前用它算包围盒，省掉首帧的一次跳位。
         * 数值取自 `node-metrics.ts` 的 `NODE_SIZE`（节点真正渲染出来的尺寸），
         * **不是** `layout.ts` 里那些只用来算间距的估算盒 —— 两者不等。
         *
         * 提示只影响首帧；真实尺寸落进 `measured` 后由 RO 的值接管，
         * 所以节点自己改高度（屏幕按流宽高比调整等）不会被这里钉死。
         */
        const hint = initialSizeOf(node.kind);
        const common = {
          id: node.id,
          position: { x: node.x, y: node.y },
          draggable: true,
          initialWidth: hint.width,
          initialHeight: hint.height,
        };

        if (node.kind === 'worker' || node.kind === 'main') {
          return {
            ...common,
            type: 'agent',
            data: {
              agentId,
              workerId: node.kind === 'worker' ? node.ownerId : undefined,
              devMode,
              onPreviewImage,
            },
          };
        }

        const worker = byId.get(node.ownerId);
        if (!worker) return null;
        const browserId = worker.browserId;
        if (!browserId) return null;
        return {
          ...common,
          type: 'screen',
          data: {
            subagentId: worker.id,
            browserId,
            browserReady: !stopping && worker.browserReady,
            title: worker.subject,
            onFullscreen: () => onFullscreen?.({
              browserId,
              subagentId: worker.id,
              title: worker.subject,
            }),
          },
        };
      },
      [agentId, byId, devMode, onFullscreen, onPreviewImage, stopping],
    );

    const computedNodes = useMemo(
      () => layout.nodes.map(toFlowNode).filter((node): node is Node => node !== null),
      [layout.nodes, toFlowNode],
    );
    const computedEdges = useMemo<Edge[]>(
      () =>
        layout.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          // 命名 handle：与 `nodes.tsx` 里挂的 Handle id 对应
          sourceHandle: 'right',
          targetHandle: 'left',
          // 自定义边：四层描边 + 沿线游走的高光（见 `FlowEdge.tsx`）
          type: 'flow',
        })),
      [layout.edges],
    );

    const [nodes, setNodes, onNodesChange] = useNodesState<Node>(computedNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(computedEdges);

    /**
     * 结构变化（worker 增删、附属出现）时重建节点，**但保留用户拖过的位置**。
     * 这不是 setState-in-effect 的滥用：它是"外部数据变化 → 同步派生状态"，
     * 且以 id 集合为判据，同集合不触发。
     */
    const signature = useMemo(() => computedNodes.map((node) => node.id).join('|'), [computedNodes]);
    const dragged = useRef(new Map<string, { x: number; y: number }>());

    /**
     * 数据同步与视口适配拆成两个 effect(修复 browserReady 竞态):
     * - 节点内容(如 browserReady 翻 true)不改变 id 集合,原先只按 signature 重建
     *   会让 data 停在建点时刻的旧值,屏幕节点永远显示"等待浏览器启动";
     * - fitView 仍只在 id 集合变化时触发,数据翻转不引起视口跳动。
     */
    useEffect(() => {
      setNodes((current) => {
        const positions = new Map(current.map((node) => [node.id, node.position]));
        // 用户经 NodeResizer 手调过的显式尺寸也要在重建时保留(与拖过的位置同权)
        const sizes = new Map(
          current
            .filter((node) => node.width !== undefined && node.height !== undefined)
            .map((node) => [node.id, { width: node.width!, height: node.height! }]),
        );
        return computedNodes.map((node) => {
          const kept = dragged.current.get(node.id) ?? positions.get(node.id);
          const size = sizes.get(node.id);
          if (!kept && !size) return node;
          return { ...node, ...(kept && { position: kept }), ...size };
        });
      });
      setEdges(computedEdges);
    }, [computedNodes, computedEdges, setNodes, setEdges]);

    useEffect(() => {

      /**
       * 自动适应视图。
       *
       * 不做这一步节点会跑出可视区：布局坐标系假设整窗宽度（worker 从 x=600 起，
       * 给最左的主节点留位），而 dock 模式下画布只占右侧那一段；三个节点横跨约 1090px，
       * 画布只有 900px，默认视口 `{x:0,y:0,zoom:1}` 下只能看到一个。
       *
       * `fitView()` 自己会排队（置 `fitViewQueued` + 推一次节点队列），等
       * `nodesInitialized`（每个节点都有 `measured`）之后才真正执行，所以
       * 这里不需要"等测量"的延时。50ms 只是给受控 `nodes` 提交留一帧余量。
       *
       * ⚠️ 调试须知：`fitView` 的冲刷路径走 `requestAnimationFrame`，而 RO 与 rAF
       * 在**窗口被遮挡/最小化时被 Chromium 冻结**（`document.visibilityState === 'hidden'`，
       * 帧率 0）。那种状态下节点永远量不出尺寸、fitView 永远排队不执行，看起来像
       * "边不渲染 + 按钮失灵"，但换到窗口可见就全好。用 CDP 验证画布前必须先确认
       * `document.visibilityState === 'visible'`，否则测的是假象。
       */
      const timer = window.setTimeout(() => {
        void fitView({ padding: 0.08, maxZoom: 1.5, duration: 220 });
      }, 50);
      return () => window.clearTimeout(timer);
    }, [signature, fitView]);

    /** 记住拖动结果，避免下一次结构变化把位置冲掉 */
    const onNodeDragStop = useCallback((_: unknown, node: Node) => {
      dragged.current.set(node.id, node.position);
    }, []);

    /** 整理画布：清空拖动记录，回到布局算法给的位置 */
    const organize = useCallback(() => {
      dragged.current.clear();
      setNodes(computedNodes);
      void fitView({ padding: 0.15, duration: 220 });
    }, [computedNodes, fitView, setNodes]);

    /** 聚光灯：坐标写进 CSS 变量，不进 React 状态（每帧 setState 会拖垮画布） */
    const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      surface.style.setProperty('--spot-x', `${event.clientX - rect.left}px`);
      surface.style.setProperty('--spot-y', `${event.clientY - rect.top}px`);
      surface.dataset.spotlight = 'true';
    }, []);

    const onPointerLeave = useCallback(() => {
      const surface = surfaceRef.current;
      if (surface) delete surface.dataset.spotlight;
    }, []);

    return (
      <div
        ref={surfaceRef}
        className={styles.canvas}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          edgeTypes={CANVAS_EDGE_TYPES}
          nodeTypes={CANVAS_NODE_TYPES}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          /**
           * **内建的初始适配，别删**。它由 react-flow 自己排队到 `nodesInitialized` 之后执行，
           * 是首屏唯一可靠的适配途径 —— 我曾以"与 effect 里的 fitView 重复"为由删掉它，
           * 结果首屏适配整个失效（节点停在布局坐标 x=1212，画布只到 1512，只看得到一个）。
           */
          fitView
          fitViewOptions={{ padding: 0.08, maxZoom: 1.5 }}
          proOptions={{ hideAttribution: true }}
          panOnDrag
          panOnScroll
          zoomOnScroll
          zoomOnPinch
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          deleteKeyCode={null}
        >
          {/* 点阵背景由 CSS 画（见 canvas.module.css），不用 react-flow 的 Background —— 少一层节点 */}
          <MiniMap
            className={styles.minimap}
            /**
             * agent 节点按**状态**着色，不按类型；屏幕节点用固定色。
             */
            nodeColor={(node) => {
              if (node.type === 'screen') return 'var(--cyber-accent)';
              const worker = byId.get(String((node.data as { workerId?: string } | undefined)?.workerId ?? ''));
              if (!worker) return 'var(--status-running)';
              if (worker.interrupted) return 'var(--status-waiting)';
              if (worker.phase === 'thinking' || worker.phase === 'executing') return 'var(--cyber-primary)';
              return 'var(--status-running)';
            }}
            // 这几个 color prop 最终落到 SVG 的 fill，`var()` / `color-mix()` 在 SVG 里成立，
            // 所以不用硬编码色值（`check:styles` 的要求）。
            // 基色用 --cyber-bg（永远实底）而非 --console-canvas-bg：后者在
            // data-app-bg 下是 transparent（弥散光是默认底，因此常态透明），
            // 与 transparent 做 color-mix 会让视口遮罩整个消失
            maskColor="color-mix(in srgb, var(--cyber-bg) 72%, transparent)"
            pannable
            zoomable
          />
        </ReactFlow>

        {nodes.length === 0 && (
          <div className={styles.empty}>
            <span className={styles.emptyPill}>{emptyHint}</span>
          </div>
        )}

        <div className={styles.toolbar}>
          <Tooltip title={t('sessionWorkbenchUi.canvas.arrange')}>
            <button type="button" className={styles.toolButton} onClick={organize} aria-label={t('sessionWorkbenchUi.canvas.arrange')}>
              <Sparkles size={14} />
            </button>
          </Tooltip>
          <span className={styles.toolDivider} />
          <Tooltip title={t('sessionWorkbenchUi.canvas.zoomIn')}>
            <button
              type="button"
              className={styles.toolButton}
              onClick={() => void zoomIn({ duration: 200 })}
              aria-label={t('sessionWorkbenchUi.canvas.zoomIn')}
            >
              <Plus size={14} />
            </button>
          </Tooltip>
          <Tooltip title={t('sessionWorkbenchUi.canvas.zoomOut')}>
            <button
              type="button"
              className={styles.toolButton}
              onClick={() => void zoomOut({ duration: 200 })}
              aria-label={t('sessionWorkbenchUi.canvas.zoomOut')}
            >
              <Minus size={14} />
            </button>
          </Tooltip>
        </div>
      </div>
    );
  },
);

Inner.displayName = 'DockCanvasInner';

/**
 * 外层显式包一层带 `key` 的 `ReactFlowProvider` —— **照抄老树的形态**
 * （`AgentCanvas.tsx:1733`：「每种布局维护独立的 ReactFlow store」）。
 *
 * 显式 provider 让 `useReactFlow()` 与挂载实例确定共用同一个 store；`key` 按 agent 走，
 * 切会话时重建 store，不残留上一个会话的视口与选中。
 */
export const DockCanvas = memo<DockCanvasProps>((props) => (
  <ReactFlowProvider key={props.agentId}>
    <Inner {...props} />
  </ReactFlowProvider>
));

DockCanvas.displayName = 'DockCanvas';
