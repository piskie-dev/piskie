/**
 * hover 意图（延迟进入 / 延迟离开）。
 *
 * 原生 popover 没有 hover 触发语义，这是替换 AntD Tooltip 的 `mouseEnterDelay` /
 * `mouseLeaveDelay` 时唯一需要自己补的那一小块。
 *
 * 语义与 AntD 一致：
 * - 进入需持续悬停 `enterDelay` 才算"有意"，避免划过就弹
 * - 离开留 `leaveDelay` 缓冲，避免指针经过缝隙时闪灭
 * - 键盘焦点**立即**打开（无延迟）——延迟只针对指针
 *
 * 实现约束：计时器只在**事件处理器**里起停，不在 effect 体里 setState
 * （React Compiler 系 lint 会拦"effect 内同步 setState 引发级联渲染"，而它是对的：
 * 延迟本身是交互的一部分，本就该由交互触发，不该绕一圈经过 render）。
 * ref 也只在处理器与 cleanup 里碰，不在 render 期读写。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface HoverIntentOptions {
  readonly enterDelay?: number;
  readonly leaveDelay?: number;
}

export interface HoverIntentHandlers {
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
}

export interface HoverIntent {
  readonly open: boolean;
  readonly handlers: HoverIntentHandlers;
  readonly close: () => void;
}

export function useHoverIntent(options: HoverIntentOptions = {}): HoverIntent {
  const { enterDelay = 140, leaveDelay = 60 } = options;
  const [open, setOpen] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const schedule = useCallback(
    (next: boolean, delay: number) => {
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        setOpen(next);
      }, delay);
    },
    [clearTimer],
  );

  // 卸载时清理悬挂计时器（effect 里碰 ref 是允许的）
  useEffect(() => clearTimer, [clearTimer]);

  const close = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  const handlers = useMemo<HoverIntentHandlers>(
    () => ({
      onPointerEnter: () => schedule(true, enterDelay),
      onPointerLeave: () => schedule(false, leaveDelay),
      // 键盘可达性：焦点即刻显示/隐藏，不走延迟
      onFocus: () => {
        clearTimer();
        setOpen(true);
      },
      onBlur: () => {
        clearTimer();
        setOpen(false);
      },
    }),
    [schedule, clearTimer, enterDelay, leaveDelay],
  );

  return { open, handlers, close };
}
