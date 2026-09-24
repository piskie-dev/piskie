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

import { ShortcutOverlayParentProvider, useDismissShortcutScope } from '@/shortcuts';
import styles from './overlay.module.css';

export interface PopoverProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 触发器：会被套一层 span 以承载 anchor-name */
  readonly trigger: React.ReactNode;
  readonly children: React.ReactNode;
  /** 浮层贴哪一侧；默认下方，越界自动翻转 */
  readonly placement?: 'block-end' | 'block-start' | 'inline-end' | 'inline-start';
  /** 沿垂直于弹出方向的轴对齐触发器；默认末端对齐 */
  readonly align?: 'start' | 'end';
  /** 承载 anchor-name 的触发器外层样式 */
  readonly triggerClassName?: string;
  readonly className?: string;
}

const PLACEMENT_AREA: Record<NonNullable<PopoverProps['placement']>, Record<NonNullable<PopoverProps['align']>, string>> = {
  'block-end': { start: 'block-end span-inline-end', end: 'block-end span-inline-start' },
  'block-start': { start: 'block-start span-inline-end', end: 'block-start span-inline-start' },
  'inline-end': { start: 'inline-end span-block-end', end: 'inline-end span-block-start' },
  'inline-start': { start: 'inline-start span-block-end', end: 'inline-start span-block-start' },
};

export const Popover: React.FC<PopoverProps> = ({
  open,
  onClose,
  trigger,
  children,
  placement = 'block-end',
  align = 'end',
  triggerClassName,
  className,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  const rawId = useId();
  const anchorName = `--anchor-${rawId.replace(/[^a-zA-Z0-9-]/g, '')}`;
  const shortcutScopeId = useDismissShortcutScope({
    scopeIdPrefix: 'console-popover',
    active: open,
    handling: 'execute',
    onDismiss: onClose,
  });

  useEffect(() => {
    openRef.current = open;
  }, [open]);

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

  // Browser light-dismiss still needs to flow back into the controlled state.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const onToggle = (event: Event): void => {
      const { newState } = event as ToggleEvent;
      if (newState === 'closed' && openRef.current) onClose();
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
          positionArea: PLACEMENT_AREA[placement][align],
        }}
      >
        <ShortcutOverlayParentProvider scopeId={shortcutScopeId}>
          {children}
        </ShortcutOverlayParentProvider>
      </div>
    </>
  );
};
