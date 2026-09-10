/**
 * 活动徽标聚合的单测。钉住四条口径：
 * 1. 只数成功（failed / cancelled / running 一律不计）
 * 2. 改动行数与审阅面板同源，文件按路径去重
 * 3. 截图与等待不算动作步
 * 4. read / grep 这类纯过程不进任何计数
 */

import { describe, expect, it } from 'vitest';

import type { FileOp } from '../cells/fileOp';
import type { TranscriptNode, ToolNode } from '@/domains/transcript/nodes';
import { activityChips, EMPTY_ACTIVITY, hasActivity } from '../activity';
import { diffLines } from '../diffLines';
import { unifiedDiff } from '../../../../../electron/tools/fs/_lib/diff';
import { fileChangeOf } from '../review';
import { projectToolArtifacts } from '../toolArtifacts';

function toolCell(over: {
  id: string;
  tool: string;
  phase?: ToolNode['state']['phase'];
  fileOp?: FileOp;
  artifacts?: ToolNode['artifacts'];
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
    artifacts: over.artifacts,
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
    expect(chips.filesChanged).toBe(1);
  });

  it('重复修改同一文件只计一个文件，行数累计每次成功改动', () => {
    const cells = [
      toolCell({ id: 'create', tool: 'write', fileOp: { kind: 'write', path: '/workspace/sample.txt', content: 'alpha\nbeta' } }),
      toolCell({ id: 'edit-first', tool: 'edit', fileOp: { kind: 'edit', path: '/workspace/sample.txt', oldText: 'alpha', newText: 'gamma', replaceAll: false } }),
      toolCell({ id: 'edit-second', tool: 'edit', fileOp: { kind: 'edit', path: '/workspace/sample.txt', oldText: 'beta', newText: 'delta', replaceAll: false } }),
      toolCell({ id: 'create-second', tool: 'write', fileOp: { kind: 'write', path: '/workspace/another.txt', content: 'one\ntwo' } }),
      toolCell({ id: 'read-only', tool: 'read', fileOp: { kind: 'read', path: '/workspace/reference.txt', content: 'reference' } }),
    ];

    expect(activityChips(cells)).toMatchObject({ filesChanged: 2, added: 6, removed: 2 });
  });

  it('批量替换使用执行期全部改动，与审阅面板一致且不重复计算参数', () => {
    const path = '/workspace/sample.txt';
    const diff = unifiedDiff(path, 'old\ngap\nold\n', 'new\nextra\ngap\nnew\nextra\n');
    const cell = toolCell({
      id: 'replace-all',
      tool: 'edit',
      fileOp: { kind: 'edit', path, oldText: 'old', newText: 'new\nextra', replaceAll: true },
      artifacts: projectToolArtifacts([{ kind: 'file_diff', payload: { path, ...diff } }], { params: {} }),
    });

    const chips = activityChips([cell]);
    expect(chips).toMatchObject({ filesChanged: 1, added: 4, removed: 2 });
    expect({ added: chips.added, removed: chips.removed }).toEqual(fileChangeOf(cell)?.stat);
  });

  it('只数成功：failed / running / cancelled / awaiting-approval 的改动与动作不计', () => {
    const cells: TranscriptNode[] = [
      toolCell({ id: 'f', tool: 'write', phase: 'failed', fileOp: { kind: 'write', path: '/a', content: 'x' } }),
      toolCell({ id: 'r', tool: 'browser_click', phase: 'running' }),
      toolCell({ id: 'cancelled', tool: 'edit', phase: 'cancelled', fileOp: { kind: 'edit', path: '/workspace/sample.txt', oldText: 'old', newText: 'new', replaceAll: false } }),
      toolCell({ id: 'approval', tool: 'write', phase: 'awaiting-approval', fileOp: { kind: 'write', path: '/workspace/another.txt', content: 'pending' } }),
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
