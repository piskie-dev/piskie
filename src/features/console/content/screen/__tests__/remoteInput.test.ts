/**
 * 远程输入换算的不变量。
 *
 * 这两块逻辑错了都不会报错，只会表现为"点不准"和"打不出字"——必须有测试钉住。
 */

import { describe, expect, it } from 'vitest';

import { buttonNameOf, modifiersOf, toKeyEvent, toPageCoords } from '../remoteInput';

/** 造一个只提供 getBoundingClientRect 的元素替身 */
function elementWithRect(width: number, height: number, left = 0, top = 0): HTMLElement {
  return {
    getBoundingClientRect: () => ({ width, height, left, top, right: left + width, bottom: top + height }),
  } as unknown as HTMLElement;
}

describe('toPageCoords', () => {
  it('等比同框时按比例线性映射', () => {
    // 元素 800×450，帧 1600×900（2:1 缩放，无留边）
    const element = elementWithRect(800, 450);
    expect(toPageCoords(element, 400, 225, { width: 1600, height: 900 })).toEqual({ x: 800, y: 450 });
  });

  it('宽画面在高元素里：上下留边要从坐标里扣掉', () => {
    // 元素 800×600、帧 1600×900 ⇒ scale=0.5，显示 800×450，上下各留 75
    const element = elementWithRect(800, 600);
    const frame = { width: 1600, height: 900 };
    // 元素顶端往下 75px 正是画面第一行
    expect(toPageCoords(element, 0, 75, frame)).toEqual({ x: 0, y: 0 });
    // 画面正中
    expect(toPageCoords(element, 400, 300, frame)).toEqual({ x: 800, y: 450 });
  });

  it('元素在页面里的偏移要计入', () => {
    const element = elementWithRect(800, 450, 100, 50);
    expect(toPageCoords(element, 100, 50, { width: 1600, height: 900 })).toEqual({ x: 0, y: 0 });
  });

  it('点在留边（画面之外）返回 null —— 那里没有对应的页面坐标', () => {
    const element = elementWithRect(800, 600);
    const frame = { width: 1600, height: 900 };
    expect(toPageCoords(element, 400, 10, frame)).toBeNull(); // 上留边
    expect(toPageCoords(element, 400, 590, frame)).toBeNull(); // 下留边
  });

  it('尺寸为 0 时返回 null，不产生 NaN 坐标', () => {
    expect(toPageCoords(elementWithRect(0, 0), 10, 10, { width: 100, height: 100 })).toBeNull();
    expect(toPageCoords(elementWithRect(100, 100), 10, 10, { width: 0, height: 0 })).toBeNull();
  });
});

describe('toKeyEvent', () => {
  const keyboardEvent = (init: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ key: '', code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init }) as KeyboardEvent;

  it('可打印字符走 char 并带上文本', () => {
    const event = toKeyEvent(keyboardEvent({ key: 'a', code: 'KeyA' }), 'down');
    expect(event).toMatchObject({ type: 'char', text: 'a' });
  });

  it('可打印字符的抬起不重复发送', () => {
    expect(toKeyEvent(keyboardEvent({ key: 'a' }), 'up')).toBeNull();
  });

  it('功能键走 keyDown/keyUp 并带虚拟键码', () => {
    expect(toKeyEvent(keyboardEvent({ key: 'Enter' }), 'down')).toMatchObject({
      type: 'keyDown',
      windowsVirtualKeyCode: 13,
    });
    expect(toKeyEvent(keyboardEvent({ key: 'ArrowDown' }), 'up')).toMatchObject({
      type: 'keyUp',
      windowsVirtualKeyCode: 40,
    });
  });

  it('纯修饰键不转发', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
      expect(toKeyEvent(keyboardEvent({ key }), 'down')).toBeNull();
    }
  });

  it('带 Ctrl 的字母走 keyDown 而非 char —— 否则快捷键会变成往输入框打字', () => {
    expect(toKeyEvent(keyboardEvent({ key: 'a', ctrlKey: true }), 'down')).toMatchObject({
      type: 'keyDown',
    });
  });
});

describe('modifiersOf / buttonNameOf', () => {
  it('修饰键按 CDP 位掩码组合', () => {
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(0);
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: true, shiftKey: false })).toBe(4);
  });

  it('鼠标键序号按 DOM 语义映射（1 是中键，不是右键）', () => {
    expect(buttonNameOf(0)).toBe('left');
    expect(buttonNameOf(1)).toBe('middle');
    expect(buttonNameOf(2)).toBe('right');
    expect(buttonNameOf(9)).toBe('none');
  });
});
