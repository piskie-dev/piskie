/**
 * PopShell —— shared 层的原生 popover + CSS anchor positioning 底盘(去 antd 弹层)。
 *
 * 浏览器负责 top layer / light-dismiss(点外关) / Esc / 越界自动翻转;
 * 本组件只做 React 受控开合与锚点绑定。底盘自身完全透明——面板的
 * 底色/描边/阴影由 children 自带,复用方各保持原有观感。
 */

import React, { useEffect, useId, useRef } from 'react';

import styles from './popShell.module.css';

export interface PopShellProps {
  readonly open: boolean;
  /** light-dismiss / Esc 由浏览器发起,经此回流受控状态 */
  readonly onClose: () => void;
  /** 触发器:外面会套一层 span 承载 anchor-name */
  readonly trigger: React.ReactNode;
  readonly children: React.ReactNode;
  /** 浮层贴哪一侧,默认下方左对齐;越界自动翻转 */
  readonly placement?: 'block-end' | 'block-start';
  readonly triggerClassName?: string;
  readonly className?: string;
}

export const PopShell: React.FC<PopShellProps> = ({
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
  const anchorName = `--pop-${rawId.replace(/[^a-zA-Z0-9-]/g, '')}`;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const isOpen = element.matches(':popover-open');
    if (open && !isOpen) element.showPopover();
    else if (!open && isOpen) element.hidePopover();
  }, [open]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onToggle = (event: Event): void => {
      if ((event as ToggleEvent).newState === 'closed') onClose();
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
        data-placement={placement}
        className={`${styles.shell} ${className ?? ''}`}
        style={{ positionAnchor: anchorName }}
      >
        {children}
      </div>
    </>
  );
};
