/**
 * 页面级键盘编排。
 *
 * 唯一的全局监听挂在这里（`attachKeyboardListener`），绑定通过
 * `data/keyboard` 的注册表登记 —— 组件不各自 `window.addEventListener('keydown')`。
 *
 * Esc 优先级链：
 * ```
 * 最上层原生 overlay（dialog / popover）→ 本层完全让位，由浏览器关
 *   → 清除 worker 选中（回到主会话）
 *   → 否则无动作（**不做「中断 agent」**，避免误触）
 * ```
 * 规格链里的「关闭输入器浮层」一级是空的：composer 贴底内联，没有 portal 浮层输入器。
 *
 * 有活动会话时，`⌘\` 切换显示方式（唯一的全局快捷键）。
 * 与 `electron/main.ts` 的 `before-input-event` 无冲突：那边只禁用了 `mod+r/f/g/p`。
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { attachKeyboardListener, registerGlobalBinding } from '../data/keyboard';

export interface ConsoleKeyboardOptions {
  readonly toggleModeEnabled: boolean;
  readonly onToggleMode: () => void;
  /** 返回 true 表示"我处理了"（有 worker 选中并已清除） */
  readonly onEscape: () => boolean;
}

export function useConsoleKeyboard({ toggleModeEnabled, onToggleMode, onEscape }: ConsoleKeyboardOptions): void {
  const { t } = useTranslation();
  // 全局监听只挂一次，且只在控制台挂载期间存在
  useEffect(() => attachKeyboardListener(), []);

  useEffect(() => {
    if (!toggleModeEnabled) return;
    return registerGlobalBinding({
      combo: 'mod+\\',
      description: t('sessionWorkbenchUi.keyboard.switchLayout'),
      run: onToggleMode,
    });
  }, [onToggleMode, t, toggleModeEnabled]);

  useEffect(
    () =>
      registerGlobalBinding({
        combo: 'escape',
        description: t('sessionWorkbenchUi.keyboard.clearWorkerSelection'),
        run: () => {
          onEscape();
        },
      }),
    [onEscape, t],
  );
}
