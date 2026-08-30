/**
 * 活动徽标聚合的单测。钉住四条口径：
 * 1. 只数成功（failed / cancelled / running 一律不计）
 * 2. 改动行数与审阅面板同源（同一个 diffLines，数字必须一致）
 * 3. 截图与等待不算动作步
 * 4. read / grep 这类纯过程不进任何计数
 */

import { describe, expect, it } from 'vitest';

import type { FileOp } from '../cells/fileOp';
import type { TranscriptNode, ToolNode } from '@/domains/transcript/nodes';
import { activityChips, EMPTY_ACTIVITY, hasActivity } from '../activity';
import { diffLines } from '../diffLines';

function toolCell(over: {
  id: string;
  tool: string;
  phase?: ToolNode['state']['phase'];
  fileOp?: FileOp;
}): ToolNode {
  const phase = over.phase ?? 'ok';
  return {
    kind: 'tool',
    id: over.id,
    ts: 0,
    sourceIndex: 0,
    tool: over.tool,
    titleKey: 't',
    tone: 'neutral',
    interaction: 'expand',
    defaultExpanded: false,
    summaryDuplicatesDetail: false,
    actions: [],
    state: phase === 'failed' ? { phase, error: 'x' } : ({ phase } as ToolNode['state']),
    fileOp: over.fileOp,
  };
}

describe('activityChips', () => {
  it('空流水 ⇒ 全零', () => {
    expect(activityChips([])).toEqual(EMPTY_ACTIVITY);
    expect(hasActivity(EMPTY_ACTIVITY)).toBe(false);
  });

  it('write 全量按新增计，edit 走 diff —— 与审阅面板同源', () => {
    const cells: TranscriptNode[] = [
      toolCell({ id: 'w', tool: 'write', fileOp: { kind: 'write', path: '/a.ts', content: 'a\nb\nc' } }),
      toolCell({
        id: 'e',
        tool: 'edit',
        fileOp: { kind: 'edit', path: '/a.ts', oldText: 'a\nb', newText: 'a\nx\ny', replaceAll: false },
      }),
    ];
    const expected = diffLines('a\nb', 'a\nx\ny').stat;
    const chips = activityChips(cells);
    expect(chips.added).toBe(3 + expected.added);
    expect(chips.removed).toBe(0 + expected.removed);
  });

  it('只数成功：failed / running 的改动与动作不计', () => {
    const cells: TranscriptNode[] = [
      toolCell({ id: 'f', tool: 'write', phase: 'failed', fileOp: { kind: 'write', path: '/a', content: 'x' } }),
      toolCell({ id: 'r', tool: 'browser_click', phase: 'running' }),
    ];
    expect(activityChips(cells)).toEqual(EMPTY_ACTIVITY);
  });

  it('浏览器截图与等待不算动作步', () => {
    const cells: TranscriptNode[] = [
      toolCell({ id: '1', tool: 'browser_click' }),
      toolCell({ id: '2', tool: 'browser_takeScreenshot' }),
      toolCell({ id: '3', tool: 'browser_wait' }),
      toolCell({ id: '4', tool: 'browser_skill_build' }),
    ];
    const chips = activityChips(cells);
    expect(chips.browserSteps).toBe(1);
  });

  it('纯过程（read / grep / send_event）不进任何计数', () => {
    const cells: TranscriptNode[] = [
      toolCell({ id: '1', tool: 'read', fileOp: { kind: 'read', path: '/a', content: 'x', startLine: 1 } }),
      toolCell({ id: '2', tool: 'grep' }),
      toolCell({ id: '3', tool: 'send_event' }),
    ];
    expect(activityChips(cells)).toEqual(EMPTY_ACTIVITY);
  });

  it('命令 / 技能 / 生图各归各', () => {
    const cells: TranscriptNode[] = [
      toolCell({ id: '1', tool: 'shell' }),
      toolCell({ id: '2', tool: 'shell' }),
      toolCell({ id: '3', tool: 'skill_call' }),
      toolCell({ id: '4', tool: 'generate_image' }),
    ];
    const chips = activityChips(cells);
    expect(chips.commands).toBe(2);
    expect(chips.skillCalls).toBe(1);
    expect(chips.images).toBe(1);
    expect(hasActivity(chips)).toBe(true);
  });
});
