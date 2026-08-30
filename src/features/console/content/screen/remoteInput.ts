/**
 * remoteInput —— 浏览器实时预览的输入换算。
 *
 * 两件容易搞错的事集中在这里：
 *
 * 1. **坐标**：canvas 用 `object-fit: contain` 显示，画面在元素框里是**居中留边**的。
 *    直接拿 `offsetX/offsetY` 会把留边算进去，点击位置整体偏移。必须先按
 *    帧尺寸与元素框算出实际显示矩形，再映射回被控页面的视口 CSS 像素。
 *
 * 2. **按键**：CDP 不认 DOM 的 KeyboardEvent。可打印字符走 `char`（带 text），
 *    功能键走 `keyDown/keyUp`（带 windowsVirtualKeyCode）——只发其中一种，
 *    两种都发会让输入框收到两次。
 */

import type { RemoteInputEvent } from '../../../../../shared/types/stream';

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/** CDP modifiers 位掩码 */
export function modifiersOf(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

const BUTTON_NAMES = ['left', 'middle', 'right', 'back', 'forward'] as const;

export function buttonNameOf(button: number): 'left' | 'middle' | 'right' | 'back' | 'forward' | 'none' {
  return BUTTON_NAMES[button] ?? 'none';
}

/**
 * 元素内的指针位置 → 被控页面视口 CSS 像素。
 * 落在留边区域（画面之外）时返回 null —— 那里没有对应的页面坐标，不该转发。
 */
export function toPageCoords(
  element: HTMLElement,
  clientX: number,
  clientY: number,
  frame: FrameSize,
): { x: number; y: number } | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;

  // object-fit: contain —— 等比缩放到"装得下"，短边留黑边
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
  const shownWidth = frame.width * scale;
  const shownHeight = frame.height * scale;
  const offsetX = (rect.width - shownWidth) / 2;
  const offsetY = (rect.height - shownHeight) / 2;

  const x = (clientX - rect.left - offsetX) / scale;
  const y = (clientY - rect.top - offsetY) / scale;
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
  return { x, y };
}

/** 功能键 → Windows 虚拟键码（只列会真正改变页面行为的那些） */
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
};

/**
 * DOM 键盘事件 → CDP 键事件。
 * 返回 null 表示无需转发（纯修饰键等）。
 */
export function toKeyEvent(
  event: KeyboardEvent,
  phase: 'down' | 'up',
): Extract<RemoteInputEvent, { kind: 'key' }> | null {
  const { key } = event;
  if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return null;

  const modifiers = modifiersOf(event);
  const virtualKeyCode = VIRTUAL_KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);

  // 可打印字符且无 Ctrl/Meta：用 char 事件带上文本，输入框才会真的落字
  const isPrintable = key.length === 1 && !event.ctrlKey && !event.metaKey;
  if (isPrintable) {
    // char 只在按下时发一次；抬起没有对应语义
    if (phase === 'up') return null;
    return { kind: 'key', type: 'char', key, code: event.code, text: key, windowsVirtualKeyCode: virtualKeyCode, modifiers };
  }

  return {
    kind: 'key',
    type: phase === 'down' ? 'keyDown' : 'keyUp',
    key,
    code: event.code,
    windowsVirtualKeyCode: virtualKeyCode,
    modifiers,
  };
}
