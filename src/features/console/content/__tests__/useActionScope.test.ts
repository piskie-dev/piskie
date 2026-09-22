/**
 * `findShortcutAction` 的单测 —— 快捷键在焦点面板内该命中哪一条 cell。
 *
 * 固定三条语义：**从尾部往前**（并行调用时指最新那条）、跳过 `enabled: false`、
 * 只认可后台化动作。具体键位由命令 catalog 与用户设置派生，不进入 transcript fixture。
 */

import { describe, expect, it } from 'vitest';

import type { TranscriptNode, TranscriptAction, ToolNode } from '@/domains/transcript/nodes';
import { findShortcutAction } from '../useActionScope';

function toolCell(id: string, actions: readonly TranscriptAction[]): ToolNode {
  return {
    kind: 'tool',
    id,
    ts: 0,
    sourceIndex: 0,
    tool: 'shell',
    titleKey: id,
    tone: 'neutral',
    interaction: 'expand',
    defaultExpanded: false,
    summaryDuplicatesDetail: false,
    actions,
    state: { phase: 'running' },
  };
}

const promote = (callId: string, enabled = true): TranscriptAction => ({
  kind: 'promote-to-background',
  enabled,
  callId,
});

describe('findShortcutAction', () => {
  it('没有任何动作时返回 null', () => {
    expect(findShortcutAction([toolCell('a', [])])).toBeNull();
  });

  it('多条并行时取最靠后的那条（与旧实现同口径）', () => {
    const cells: TranscriptNode[] = [toolCell('early', [promote('call-1')]), toolCell('late', [promote('call-2')])];
    expect(findShortcutAction(cells)?.action.callId).toBe('call-2');
  });

  it('跳过 enabled: false，继续往前找', () => {
    const cells: TranscriptNode[] = [toolCell('usable', [promote('call-1')]), toolCell('locked', [promote('call-2', false)])];
    expect(findShortcutAction(cells)?.action.callId).toBe('call-1');
  });

  it('非工具 cell 一律跳过（只有 ToolNode 带 actions）', () => {
    const user: TranscriptNode = {
      kind: 'user',
      id: 'u',
      ts: 0,
      sourceIndex: 0,
      titleKey: 'u',
      tone: 'neutral',
      interaction: 'none',
      defaultExpanded: false,
      summaryDuplicatesDetail: false,
      origin: 'user',
      text: 'hi',
    };
    expect(findShortcutAction([user])).toBeNull();
  });
});
