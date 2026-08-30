/**
 * 保真度分级。
 *
 * 两个执行面，缺一不可：
 *
 * | 面 | 手段 |
 * |---|---|
 * | 浏览器（layout / paint） | `content-visibility: hidden` / `auto` —— 由 CSS 决定 |
 * | React（reconcile） | 订阅门控 —— `useTranscript({ active })` 等由本模块给出的 `active` 决定 |
 *
 * 只做 CSS 那一半是假冻结：隐藏面板订阅的 store 分片一变，React 照样 reconcile。
 *
 * 三档（原设计四档，`peripheral` 随"不同屏罗列 worker"一起取消）：
 * - `focused`   用户正在看且操作：全量 + 独占键盘作用域 + 流 24fps
 * - `visible`   同屏但非焦点：全量，流 24fps
 * - `hidden`    切走但保挂载：不订阅、不重投影、流暂停；DOM 与滚动位置留着
 */

export type Fidelity = 'focused' | 'visible' | 'hidden';

export function isActive(fidelity: Fidelity): boolean {
  return fidelity !== 'hidden';
}
