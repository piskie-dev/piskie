/**
 * overlayPresence —— 应用级浮层在场计数（z-order 协调的最小原语）。
 *
 * WebContentsView（内嵌浏览器）恒浮在页面内容之上；弹窗/抽屉/灯箱出现时
 * 必须把视图藏起来，否则被网页盖住。浮层所有者在挂载期间 acquire，
 * 内嵌浏览器面板订阅计数：>0 即 setVisible(false)。
 *
 * 刻意做成模块级外部 store（useSyncExternalStore 消费）而不进 zustand：
 * 它是 UI 基建不是业务状态，且要被 chrome/content/modes 各层零成本引用。
 */

let count = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 浮层出现时调用；返回释放函数（幂等，重复调用只减一次） */
export function acquireOverlay(): () => void {
  count += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    count -= 1;
    emit();
  };
}

export function getOverlayCount(): number {
  return count;
}

export function subscribeOverlay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
