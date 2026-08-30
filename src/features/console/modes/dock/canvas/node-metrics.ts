/**
 * 画布节点的渲染尺寸常量与纯计算 —— 零 React、零组件依赖。
 * 从 `nodes.tsx` 拆出:让单测不必拉起组件导入链(DockPanel 及其重依赖)。
 */

/**
 * 各节点的渲染尺寸。被包的组件都是 `block-size: 100%`，所以高度必须由这里给出定值。
 */
export const NODE_SIZE = {
  /**
   * worker 宽 560：底部工具行（作用域 + 模型/计划/审批药丸 + 发送）在 480 以下会换行。
   * 改这个值要同步 `layout.ts` 的估算盒，保持"估算盒 = 渲染宽 + 40"。
   */
  worker: { width: 560, height: 880 },
  /**
   * 屏幕：640 宽，高按流的**真实宽高比**（screencast 缩放保持页面视口比例，
   * 首帧未到时按 16:10 兜底）。它是 worker 的唯一附属，与 worker 顶部对齐。
   *
   * 注意它会**溢出 lane 的横向配额**（`layout.ts` 按 280 算间距），这是有意的：
   * 屏幕预览宽一些更可读，相邻列的留白足以吸收。
   */
  screen: {
    width: 640,
    /** 壳与画面区的实测差:两轴各 2px(1px 边框 ×2);现版 ScreenView 没有头部行 */
    chrome: 2,
    fallbackAspect: 16 / 10,
    /** 自动高度封顶（与 worker 渲染高一致）；竖屏视口按比例反向收窄宽度 */
    maxAutoHeight: 880,
  },
} as const;

/** 屏幕节点手调下限（NodeResizer） */
export const SCREEN_MIN = { width: 320, height: 200 } as const;

/**
 * 按流的真实宽高比算屏幕节点的默认渲染尺寸。
 * 横屏视口:定宽 640,高随比例;竖屏视口高会超限,改为封顶高度、按比例收窄宽度。
 */
export function screenAutoSize(ratio: number | null): { width: number; height: number } {
  const size = NODE_SIZE.screen;
  const aspect = ratio ?? size.fallbackAspect;
  const width = size.width;
  const height = Math.round(size.chrome + (width - size.chrome) / aspect);
  if (height <= size.maxAutoHeight) return { width, height };
  return {
    width: Math.max(
      SCREEN_MIN.width,
      Math.round(size.chrome + (size.maxAutoHeight - size.chrome) * aspect),
    ),
    height: size.maxAutoHeight,
  };
}
