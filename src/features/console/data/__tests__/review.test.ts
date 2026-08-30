/**
 * 单次文件改动解读的单测。
 *
 * 审阅面只回答「点的这条改了什么」：每条 cell 各自还原成一份单次 diff，
 * 不聚合、不跨轮次合并。这里逐条固定 write/edit/read/失败/非工具的解读结果。
 */

import { describe, expect, it } from 'vitest';

import type { FileOp } from '../cells/fileOp';
import type { TranscriptNode, ToolNode } from '@/domains/transcript/nodes';
import { basename, fileChangeOf, readOpOf } from '../review';

function toolCell(over: {
  id: string;
  fileOp?: FileOp;
  phase?: ToolNode['state']['phase'];
}): ToolNode {
  const phase = over.phase ?? 'ok';
  return {
    kind: 'tool',
    id: over.id,
    ts: 0,
    sourceIndex: 0,
    tool: over.fileOp?.kind === 'read' ? 'read' : (over.fileOp?.kind ?? 'shell'),
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

describe('basename', () => {
  it('取路径末段，兼容 Windows 分隔符', () => {
    expect(basename('/a/b/c.ts')).toBe('c.ts');
    expect(basename('C:\\x\\y.txt')).toBe('y.txt');
    expect(basename('solo.md')).toBe('solo.md');
  });
});

describe('fileChangeOf', () => {
  it('write 全部计为新增，行号准确（absoluteLines）', () => {
    const change = fileChangeOf(
      toolCell({ id: 'c1', fileOp: { kind: 'write', path: '/a/x.ts', content: 'l1\nl2\nl3' } }),
    );

    expect(change?.name).toBe('x.ts');
    expect(change?.kind).toBe('write');
    expect(change?.absoluteLines).toBe(true);
    expect(change?.stat).toEqual({ added: 3, removed: 0 });
  });

  it('edit 的行号不可信，absoluteLines 为 false', () => {
    const change = fileChangeOf(
      toolCell({
        id: 'c1',
        fileOp: { kind: 'edit', path: '/a/x.ts', oldText: 'a', newText: 'b', replaceAll: false },
      }),
    );

    expect(change?.kind).toBe('edit');
    expect(change?.absoluteLines).toBe(false);
    expect(change?.stat).toEqual({ added: 1, removed: 1 });
  });

  it('只解读被点这一条，不牵连同文件其它轮次', () => {
    // 同一文件先 write 后 edit：各自独立解读，互不影响（不再聚合成一个文件桶）
    const write = fileChangeOf(
      toolCell({ id: 'c1', fileOp: { kind: 'write', path: '/a/x.ts', content: 'v1' } }),
    );
    const edit = fileChangeOf(
      toolCell({
        id: 'c2',
        fileOp: { kind: 'edit', path: '/a/x.ts', oldText: 'v1', newText: 'v2', replaceAll: false },
      }),
    );

    expect(write?.stat).toEqual({ added: 1, removed: 0 });
    expect(edit?.stat).toEqual({ added: 1, removed: 1 });
  });

  it('失败的改动 ⇒ null（没落盘，展示会误导）', () => {
    const change = fileChangeOf(
      toolCell({ id: 'c1', phase: 'failed', fileOp: { kind: 'write', path: '/a/x.ts', content: 'l1' } }),
    );

    expect(change).toBeNull();
  });

  it('read ⇒ null（它不改盘上内容，走 readOpOf）', () => {
    const change = fileChangeOf(
      toolCell({ id: 'c1', fileOp: { kind: 'read', path: '/a/x.ts', content: 'l1' } }),
    );

    expect(change).toBeNull();
  });

  it('非工具 cell ⇒ null（不抛）', () => {
    const assistant: TranscriptNode = {
      kind: 'assistant',
      id: 'a1',
      ts: 0,
      sourceIndex: 0,
      titleKey: 'AI',
      markdown: 'hi',
      live: false,
      tone: 'neutral',
      interaction: 'none',
      defaultExpanded: false,
      summaryDuplicatesDetail: false,
    };

    expect(fileChangeOf(assistant)).toBeNull();
  });
});

describe('readOpOf', () => {
  it('read cell ⇒ 取出 read 载荷', () => {
    const op = readOpOf(
      toolCell({ id: 'c1', fileOp: { kind: 'read', path: '/a/x.ts', content: 'l1' } }),
    );

    expect(op?.kind).toBe('read');
    expect(op?.path).toBe('/a/x.ts');
  });

  it('write / edit cell ⇒ null', () => {
    expect(readOpOf(toolCell({ id: 'c1', fileOp: { kind: 'write', path: '/a.ts', content: 'x' } }))).toBeNull();
  });
});
