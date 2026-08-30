/**
 * Tooltip —— 原生 popover + anchor positioning + hover 意图。
 *
 * 与 `Popover` 的区别：
 * - hover / focus 触发（`useHoverIntent` 提供延迟语义），不是受控开合
 * - `pointer-events: none`，不吃指针，不会挡住触发器
 * - `role="tooltip"` + `aria-describedby`：真正被读屏关联，而不只是视觉提示
 * - 默认贴上方，越界翻到下方（`position-try-fallbacks: flip-block`）；
 *   翻转后若要改箭头方向，用 `@container anchored(fallback: flip-block)`（样式里已开 `container-type: anchored`）
 */

import React, { useEffect, useId, useRef } from 'react';

import styles from './overlay.module.css';
import { useHoverIntent } from './useHoverIntent';

export interface TooltipProps {
  readonly title?: React.ReactNode;
  readonly children: React.ReactElement;
  readonly enterDelay?: number;
  readonly leaveDelay?: number;
  readonly className?: string;
}

export const Tooltip: React.FC<TooltipProps> = ({
  title,
  children,
  enterDelay,
  leaveDelay,
  className,
}) => {
  const disabled = title === undefined || title === null || title === '';
  const { open, handlers } = useHoverIntent({ enterDelay, leaveDelay });

  const ref = useRef<HTMLDivElement>(null);
  const rawId = useId();
  const tooltipId = `tooltip-${rawId.replace(/[^a-zA-Z0-9-]/g, '')}`;
  const anchorName = `--anchor-${tooltipId}`;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const isOpen = element.matches(':popover-open');
    if (open && !isOpen) {
      element.showPopover();
    } else if (!open && isOpen) {
      element.hidePopover();
    }
  }, [open]);

  if (disabled) return children;

  /**
   * `anchor-name` 必须落在**生成盒子的元素**上：包装 span 是 `display: contents`
   * （不产生盒），锚在它身上解析不到，浮层会回落 `position: fixed` 的静态位
   * ——视口左上角。所以把锚名注入真实子元素的 style。
   */
  const anchored = React.cloneElement(children, {
    style: { ...(children.props as { style?: React.CSSProperties }).style, anchorName },
  } as React.HTMLAttributes<HTMLElement>);

  return (
    <>
      <span
        style={{ display: 'contents' }}
        aria-describedby={open ? tooltipId : undefined}
        onPointerEnter={handlers.onPointerEnter}
        onPointerLeave={handlers.onPointerLeave}
        onFocus={handlers.onFocus}
        onBlur={handlers.onBlur}
      >
        {anchored}
      </span>
      <div
        ref={ref}
        id={tooltipId}
        role="tooltip"
        // manual 而非 auto：tooltip 不该抢 light-dismiss，也不该把已打开的菜单顶掉
        popover="manual"
        className={`${styles.tooltip} ${className ?? ''}`}
        style={{ positionAnchor: anchorName }}
      >
        {title}
      </div>
    </>
  );
};
