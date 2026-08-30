/**
 * 右栏可用面板的判定——纯函数，零 React。
 *
 * ## 判据：**有内容才有 tab**
 *
 * | tab | 出现条件 |
 * |---|---|
 * | 审阅 | 用户点了某条文件操作或本地路径 |
 * | 屏幕 | worker 且有 browserId |
 * | 浏览器 | 用户手动开启（入口按钮或点流水里的链接） |
 *
 * 右栏只放这两页。任务是执行的伴随信息，归阅读列底部的共享 `TaskList`；
 * 生成的图片归流水尾部的审核块与工具行缩略图（`ToolNode.generatedImages`），
 * 右栏再开一页只会是它的真子集。
 *
 * 无条件放进列表的话，0 条时 tab 照样在、点进去只有一句「还没有任务」，纯噪音。
 *
 * **右栏该不该出现 = 有没有可用 tab**，不另算一套 `hasPanelContent` 条件——
 * 两套并行条件必然漂移。
 */

export type PanelKey = 'review' | 'screen' | 'browser';

export interface PanelCapability {
  /** worker 才可能有屏幕；主会话恒 false */
  readonly isWorker: boolean;
  readonly hasScreen: boolean;
  /** 当前会话/worker 有一个用户明确打开的文件操作或本地路径 */
  readonly hasReviewTarget: boolean;
  /** 内嵌浏览器：纯手动开启——用户点了入口或点了流水里的链接 */
  readonly hasBrowser: boolean;
}

export function availablePanels(capability: PanelCapability): readonly PanelKey[] {
  const panels: PanelKey[] = [];

  if (capability.hasReviewTarget) panels.push('review');

  if (capability.isWorker && capability.hasScreen) panels.push('screen');

  // 内嵌浏览器：手动开启才出现，人驱动，与 agent 浏览器完全隔离
  if (capability.hasBrowser) panels.push('browser');

  return panels;
}

/**
 * 保持同名选择；不可用则回落到第一个可用。
 *
 * ⚠️ 回落是**静默**的：想去某一页而它不在列表里，结果是落到别的页而不是报错。
 * 调用方要么先保证目标可用，要么接受落到别处（`__tests__/panels.test.ts` 固定了这个形状）。
 * 全空时返回 undefined —— 此时右栏根本不该渲染，不要再兜一个假的默认页。
 */
export function resolveSelectedPanel(
  wanted: PanelKey,
  panels: readonly PanelKey[],
): PanelKey | undefined {
  if (panels.includes(wanted)) return wanted;
  return panels[0];
}
