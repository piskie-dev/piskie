/** Available right-panel tabs are derived from actual content.
 * Review and manual browsing follow user selection. Worker screens require readiness;
 * the main monitor also includes allocated browsers waiting for their first picture.
 */

export type PanelKey = 'review' | 'screen' | 'browser' | 'monitor';

export interface PanelCapability {
  /** worker 才可能有屏幕；主会话恒 false */
  readonly isWorker: boolean;
  /** 已分配 browserId 且 browserReady 为 true，屏幕可以订阅 */
  readonly hasScreen: boolean;
  /** 当前会话/worker 有一个用户明确打开的文件操作或本地路径 */
  readonly hasReviewTarget: boolean;
  /** 内嵌浏览器：纯手动开启——用户点了入口或点了流水里的链接 */
  readonly hasBrowser: boolean;
  readonly hasMonitor?: boolean;
}

export function availablePanels(capability: PanelCapability): readonly PanelKey[] {
  const panels: PanelKey[] = [];

  if (capability.hasReviewTarget) panels.push('review');

  if (capability.isWorker && capability.hasScreen) panels.push('screen');

  // 内嵌浏览器：手动开启才出现，人驱动，与 agent 浏览器完全隔离
  if (capability.hasBrowser) panels.push('browser');

  if (!capability.isWorker && capability.hasMonitor) panels.push('monitor');

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
