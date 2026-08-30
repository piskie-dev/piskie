/**
 * Dialog —— 原生 `<dialog>` 封装。
 *
 * 浏览器负责的部分不自己写：
 * - **焦点陷阱**与 inert 背景：`showModal()` 自带
 * - **Esc 关闭**：close request 自带（且**先于**应用级键盘路由，正是键盘优先级链的第一级）
 * - **点外关闭**：`closedby="any"`，不需要 `document.mousedown` 监听 + 浮层白名单排除
 * - **top layer**：无需 z-index 管理
 *
 * 进出场动画在 `overlay.module.css`，按指导 transition `overlay` + `display`。
 */

import React, { useEffect, useId, useRef } from 'react';

import { acquireOverlay } from './overlayPresence';
import styles from './overlay.module.css';

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: React.ReactNode;
  readonly ariaLabel?: string;
  /** 最大宽度（px），默认 560 */
  readonly width?: number;
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
}

export const Dialog: React.FC<DialogProps> = ({
  open,
  onClose,
  title,
  ariaLabel,
  width,
  children,
  className,
  bodyClassName,
}) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // 声明式 light-dismiss：点遮罩与 Esc 都关（Chromium 134+，本项目 148）。
  // 用 setAttribute 而非 JSX 属性——eslint 的 react/no-unknown-property 尚不认识 closedby，
  // 走 DOM 设置比给 lint 加例外干净；dialog 首帧未打开，无行为间隙。
  useEffect(() => {
    ref.current?.setAttribute('closedby', 'any');
  }, []);

  // 浮层在场登记（z-order）：原生 dialog 在页面 top layer，但内嵌浏览器的
  // WebContentsView 是原生视图、恒在整个页面（含 top layer）之上——打开期间登记，
  // 让 BrowserPanel 隐藏视图。所有 Dialog 消费方（任务板/全屏投屏等）自动覆盖。
  useEffect(() => (open ? acquireOverlay() : undefined), [open]);

  // open 是受控的；用 effect 驱动命令式的 showModal/close
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // 浏览器发起的关闭（Esc / 点击遮罩）要回流到受控状态
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    const onNativeClose = (): void => onClose();
    dialog.addEventListener('close', onNativeClose);
    return () => dialog.removeEventListener('close', onNativeClose);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : ariaLabel}
      className={`${styles.dialog} ${className ?? ''}`}
      style={width ? ({ '--dialog-width': `${width}px` } as React.CSSProperties) : undefined}
    >
      {title && (
        <header className={styles.dialogHeader} id={titleId}>
          {title}
        </header>
      )}
      <div className={`${styles.dialogBody} ${bodyClassName ?? ''}`}>{children}</div>
    </dialog>
  );
};
