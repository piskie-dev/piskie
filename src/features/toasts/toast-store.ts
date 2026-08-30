/**
 * 应用级通知(toast)状态(2026-08-25 去 antd notification 重设计)。
 *
 * 语义:轻量、右上角、玻璃卡 + 左缘光条(光是唯一装饰)。
 * push 以 id 去重(同 id 刷新内容与计时),durationMs=0 为常驻(critical)。
 */

import { create } from 'zustand';

export type ToastTone = 'info' | 'warning' | 'error' | 'critical';

export interface ToastItem {
  readonly id: string;
  readonly tone: ToastTone;
  readonly title: string;
  readonly detail?: string;
  /** 0 = 常驻,需手动关闭 */
  readonly durationMs: number;
  /** push 时间戳:同 id 重推时变化,用于重置自动消隐计时 */
  readonly pushedAt: number;
}

export type ToastInput = Omit<ToastItem, 'pushedAt' | 'durationMs'> & {
  readonly durationMs?: number;
};

/** 同屏上限:超出时挤掉最旧的非常驻条目 */
const MAX_TOASTS = 5;

interface ToastStore {
  toasts: ToastItem[];
  push: (input: ToastInput) => void;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (input) => set((state) => {
    const item: ToastItem = {
      durationMs: 8000,
      ...input,
      pushedAt: Date.now(),
    };
    let next = state.toasts.filter((toast) => toast.id !== item.id);
    next = [...next, item];
    while (next.length > MAX_TOASTS) {
      const evictIndex = next.findIndex((toast) => toast.durationMs !== 0);
      if (evictIndex < 0) break;
      next = [...next.slice(0, evictIndex), ...next.slice(evictIndex + 1)];
    }
    return { toasts: next };
  }),
  dismiss: (id) => set((state) => ({
    toasts: state.toasts.filter((toast) => toast.id !== id),
  })),
}));

/** 非 React 场景直推(与 hook 同一份状态) */
export function pushToast(input: ToastInput): void {
  useToastStore.getState().push(input);
}
