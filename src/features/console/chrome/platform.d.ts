/**
 * React 18 类型尚未收录的平台属性（支持策略：Chromium 148，直接用不写 fallback）。
 *
 * `@types/react@18.3.x` 已有 `<dialog closedby>`，但缺 Popover API 与 CSS anchor positioning。
 * 这里做最小增强，让调用处不必到处 `as React.CSSProperties` 硬转——
 * 硬转会把真正的拼写错误一起吞掉。
 *
 * 升级到 React 19 类型后可删除本文件（届时 tsc 会因重复声明报错，正好提醒）。
 */

import 'react';

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> {
    // 注：类型参数必须叫 T——声明合并要求与原声明同名。
    // 改成 `_T` 会让合并失效（实测：HTMLAttributes 丢掉继承成员，消费方立刻报错），
    // 因此这里保留一条 no-unused-vars **warning**（门槛是 0 error），不为它改全局 eslint 配置。
    /** Popover API：'auto' 参与 light-dismiss 栈，'manual' 不参与（tooltip 用） */
    popover?: 'auto' | 'manual' | 'hint' | '' | undefined;
    /** 声明式触发（本项目走命令式 showPopover，保留以备用） */
    popovertarget?: string | undefined;
    popovertargetaction?: 'toggle' | 'show' | 'hide' | undefined;
  }

  interface CSSProperties {
    /** 锚点命名（触发器侧） */
    anchorName?: string;
    /** 绑定锚点（浮层侧） */
    positionAnchor?: string;
    /** 相对锚点的落位区域 */
    positionArea?: string;
    /** 越界时的候补落位 */
    positionTryFallbacks?: string;
    /** 尺寸随锚点 */
    positionVisibility?: string;
    /** 参与 top layer 进出场过渡 */
    overlay?: string;
    /** 与 content-visibility 配套的占位尺寸 */
    containIntrinsicSize?: string;
    /** 允许过渡到 auto / min-content 等内在尺寸关键字 */
    interpolateSize?: 'allow-keywords' | 'numeric-only';
  }
}
