/**
 * 键盘作用域路由测试：
 * 快捷键必须归属于**焦点面板**，不靠 `:hover` 猜，也不会多面板同时响应。
 *
 * 路由逻辑与 DOM 解耦，因此这里在 node 环境直接测纯对象派发（无需 jsdom）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dispatchKeyEvent,
  focusScope,
  getFocusedScope,
  normalizeCombo,
  registerGlobalBinding,
  registerScope,
  resetKeyboardRegistry,
} from '../keyboard';

/** mod 同时匹配 Cmd 与 Ctrl，这里用 meta 代表 */
function mod(key: string, editableTarget = false) {
  return dispatchKeyEvent({ key, metaKey: true, editableTarget });
}

beforeEach(resetKeyboardRegistry);
afterEach(resetKeyboardRegistry);

describe('normalizeCombo', () => {
  it('mod 同时接受 Cmd 与 Ctrl', () => {
    expect(normalizeCombo({ key: 'b', metaKey: true })).toBe('mod+b');
    expect(normalizeCombo({ key: 'b', ctrlKey: true })).toBe('mod+b');
  });

  it('修饰键顺序固定为 mod+alt+shift+key', () => {
    expect(normalizeCombo({ key: 'K', metaKey: true, altKey: true, shiftKey: true })).toBe(
      'mod+alt+shift+k',
    );
  });

  it('无修饰键即键名本身（小写）', () => {
    expect(normalizeCombo({ key: 'Escape' })).toBe('escape');
  });
});

describe('键盘作用域路由', () => {
  it('只有焦点作用域的绑定被触发', () => {
    const a = vi.fn();
    const b = vi.fn();
    registerScope('panel-a', [{ combo: 'mod+b', run: a }]);
    registerScope('panel-b', [{ combo: 'mod+b', run: b }]);

    focusScope('panel-a');
    expect(mod('b')).toBe(true);

    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it('切换焦点即切换归属', () => {
    const a = vi.fn();
    const b = vi.fn();
    registerScope('panel-a', [{ combo: 'mod+b', run: a }]);
    registerScope('panel-b', [{ combo: 'mod+b', run: b }]);

    focusScope('panel-b');
    mod('b');

    expect(b).toHaveBeenCalledOnce();
    expect(a).not.toHaveBeenCalled();
  });

  it('无焦点时面板绑定不触发（不再靠 hover 兜底）', () => {
    const run = vi.fn();
    registerScope('panel-a', [{ combo: 'mod+b', run }]);

    focusScope(null);
    expect(mod('b')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('全局绑定与焦点无关', () => {
    const run = vi.fn();
    registerGlobalBinding({ combo: 'mod+\\', run });

    focusScope(null);
    expect(mod('\\')).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('焦点作用域优先于全局绑定', () => {
    const scoped = vi.fn();
    const global = vi.fn();
    registerScope('panel-a', [{ combo: 'mod+b', run: scoped }]);
    registerGlobalBinding({ combo: 'mod+b', run: global });

    focusScope('panel-a');
    mod('b');

    expect(scoped).toHaveBeenCalledOnce();
    expect(global).not.toHaveBeenCalled();
  });

  it('注销后不再响应，且清掉焦点', () => {
    const run = vi.fn();
    const dispose = registerScope('panel-a', [{ combo: 'mod+b', run }]);
    focusScope('panel-a');

    dispose();
    expect(getFocusedScope()).toBeNull();
    expect(mod('b')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('全局绑定注销后不再响应', () => {
    const run = vi.fn();
    const dispose = registerGlobalBinding({ combo: 'mod+b', run });
    dispose();

    expect(mod('b')).toBe(false);
  });

  it('输入态放行带修饰键的组合', () => {
    const run = vi.fn();
    registerScope('panel-a', [{ combo: 'mod+b', run }]);
    focusScope('panel-a');

    expect(mod('b', true)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('输入态拦下无修饰键的单键，避免劫持打字', () => {
    const run = vi.fn();
    registerScope('panel-a', [{ combo: 'j', run }]);
    focusScope('panel-a');

    expect(dispatchKeyEvent({ key: 'j', editableTarget: true })).toBe(false);
    expect(run).not.toHaveBeenCalled();

    // 非输入态则正常触发
    expect(dispatchKeyEvent({ key: 'j' })).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('Esc 在输入态也放行：它不是打字键，否则焦点在 composer 时优先级链断掉', () => {
    const run = vi.fn();
    registerScope('panel-a', [{ combo: 'escape', run }]);
    focusScope('panel-a');

    expect(dispatchKeyEvent({ key: 'Escape', editableTarget: true })).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('未注册的组合不消费事件（交还给宿主/菜单加速器）', () => {
    registerScope('panel-a', [{ combo: 'mod+b', run: vi.fn() }]);
    focusScope('panel-a');

    expect(mod('k')).toBe(false);
  });
});
