/**
 * useNativeDialog —— 受控 open 与原生 `<dialog>` 的接线。
 *
 * 浏览器托管的部分不自己写：`showModal()` 自带焦点陷阱与 inert 背景，
 * `closedby="any"` 提供 Esc + 点遮罩的 light-dismiss（Chromium 148）。
 * 打开期间向 overlayPresence 登记：内嵌浏览器的 WebContentsView 是原生视图，
 * 恒在 top layer 之上，登记后 BrowserPanel 会把视图藏起来（z-order）。
 */

import { useEffect, useRef, type RefObject } from 'react';

import { acquireOverlay } from '../../features/console/chrome/overlayPresence';

export function useNativeDialog(
  open: boolean,
  onClose: () => void,
): RefObject<HTMLDialogElement> {
  const ref = useRef<HTMLDialogElement>(null);

  // setAttribute 而非 JSX 属性：react/no-unknown-property 尚不认识 closedby
  useEffect(() => {
    ref.current?.setAttribute('closedby', 'any');
  }, []);

  useEffect(() => (open ? acquireOverlay() : undefined), [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  // 浏览器发起的关闭（Esc / 点遮罩）回流到受控状态
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const sync = (): void => onClose();
    dialog.addEventListener('close', sync);
    return () => dialog.removeEventListener('close', sync);
  }, [onClose]);

  return ref;
}
