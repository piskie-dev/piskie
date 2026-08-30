/**
 * Popover —— 原生 `popover` + CSS anchor positioning 封装。
 *
 * 浏览器负责：top layer（无 z-index）、light-dismiss（点外自动关）、Esc 关闭、
 * 越界自动翻转（`position-try-fallbacks`）。
 *
 * 触发器与浮层通过 `anchor-name` / `position-anchor` 显式绑定——
 * 不用隐式锚（`popovertarget` 的隐式关系）是因为我们需要 React 受控开合，
 * 而不是声明式 invoker。
 */

import React, { useEffect, useId, useRef } from 'react';

import styles from './overlay.module.css';

export interface PopoverProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 触发器：会被套一层 span 以承载 anchor-name */
  readonly trigger: React.ReactNode;
  readonly children: React.ReactNode;
  /** 浮层贴哪一侧；默认下方左对齐，越界自动翻转 */
  readonly placement?: 'block-end' | 'block-start' | 'inline-end' | 'inline-start';
  /** 承载 anchor-name 的触发器外层样式 */
  readonly triggerClassName?: string;
  readonly className?: string;
}

const PLACEMENT_AREA: Record<NonNullable<PopoverProps['placement']>, string> = {
  'block-end': 'block-end span-inline-start',
  'block-start': 'block-start span-inline-start',
  'inline-end': 'inline-end span-block-start',
  'inline-start': 'inline-start span-block-start',
};

export const Popover: React.FC<PopoverProps> = ({
  open,
  onClose,
  trigger,
  children,
  placement = 'block-end',
  triggerClassName,
  className,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const rawId = useId();
  const anchorName = `--anchor-${rawId.replace(/[^a-zA-Z0-9-]/g, '')}`;

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

  // light-dismiss / Esc 由浏览器发起，需回流到受控状态
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const onToggle = (event: Event): void => {
      const { newState } = event as ToggleEvent;
      if (newState === 'closed') onClose();
    };

    element.addEventListener('toggle', onToggle);
    return () => element.removeEventListener('toggle', onToggle);
  }, [onClose]);

  return (
    <>
      <span className={triggerClassName} style={{ anchorName }}>{trigger}</span>
      <div
        ref={ref}
        popover="auto"
        className={`${styles.popover} ${className ?? ''}`}
        style={{
          positionAnchor: anchorName,
          positionArea: PLACEMENT_AREA[placement],
        }}
      >
        {children}
      </div>
    </>
  );
};
