/**
 * 右栏可用面板的单测。
 *
 * 两件事必须钉住，它们都会以"点了没反应 / 一片空白"的形式出现在界面上：
 *
 * 1. **有内容才有 tab**（用户 2026-07-31 反馈空 tab 噪音后立的规矩）。
 * 2. **`resolveSelectedPanel` 的回落是静默的**。想去某页而它不在列表里，
 *    结果是落到别的页 —— 调用方必须先保证目标可用。
 *
 * 「任务」已迁到共享 TaskList，「产物」不再是 tab。
 */

import { describe, expect, it } from 'vitest';

import { availablePanels, resolveSelectedPanel, type PanelCapability } from '../panels';

function cap(over: Partial<PanelCapability> = {}): PanelCapability {
  return {
    isWorker: false,
    hasScreen: false,
    hasReviewTarget: false,
    hasBrowser: false,
    ...over,
  };
}

describe('availablePanels · 有内容才有 tab', () => {
  it('什么都没有 ⇒ 一个 tab 都没有（整栏不该出现）', () => {
    expect(availablePanels(cap())).toEqual([]);
  });

  it('有明确打开的文件目标 ⇒ 审阅，且排最前', () => {
    expect(availablePanels(cap({ isWorker: true, hasReviewTarget: true, hasScreen: true }))).toEqual([
      'review',
      'screen',
    ]);
  });
});

describe('availablePanels · worker 能力位', () => {
  it('worker 的屏幕按能力位出', () => {
    expect(availablePanels(cap({ isWorker: true, hasScreen: true }))).toEqual(['screen']);
  });

  it('worker 无浏览器 ⇒ 不出屏幕', () => {
    expect(availablePanels(cap({ isWorker: true }))).toEqual([]);
  });

  it('主会话即便标了 hasScreen 也不出屏幕（主 agent 不持浏览器）', () => {
    expect(availablePanels(cap({ hasScreen: true }))).toEqual([]);
  });

  it('全能力：顺序固定为 审阅→屏幕', () => {
    expect(availablePanels(cap({ isWorker: true, hasScreen: true, hasReviewTarget: true }))).toEqual([
      'review',
      'screen',
    ]);
  });
});

describe('resolveSelectedPanel', () => {
  it('目标可用就保持同名选择', () => {
    expect(resolveSelectedPanel('screen', ['review', 'screen'])).toBe('screen');
  });

  it('目标不可用 ⇒ 静默回落第一个可用（故调用方要先让目标可用）', () => {
    expect(resolveSelectedPanel('review', ['screen'])).toBe('screen');
    expect(resolveSelectedPanel('review', ['review', 'screen'])).toBe('review');
  });

  it('空列表 ⇒ undefined，不兜假的默认页（此时右栏根本不该渲染）', () => {
    expect(resolveSelectedPanel('review', [])).toBeUndefined();
  });
});
