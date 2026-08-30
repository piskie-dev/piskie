/**
 * 单次改动的行号口径：cell 带 review slot 的 file_diff artifact 时用权威 LineDiff
 * （absoluteLines: true，真实行号），无 artifact 的 edit 退回 LCS 参数重建
 * （absoluteLines: false），write 全量路径始终 absoluteLines: true。
 *
 * 重构后不再聚合：每条 cell 各自解读，同文件多条互不牵连。
 */
import { describe, expect, it } from 'vitest';

import type { ToolNode } from '@/domains/transcript/nodes';
import { projectToolArtifacts } from '../toolArtifacts';
import { fileChangeOf, type FileChange } from '../review';
import type { ToolArtifact } from '../../../../../shared/types';

function diffArtifact(path: string, startLine: number, oldText: string, newText: string): ToolArtifact {
  return {
    kind: 'file_diff',
    payload: {
      path,
      unifiedDiff: `--- a/${path}\n+++ b/${path}\n`
        + `@@ -${startLine},1 +${startLine},1 @@\n`
        + `-${oldText}\n`
        + `+${newText}\n`,
      stat: { linesAdded: 0, linesDeleted: 0, linesChanged: 1 },
    },
  };
}

function editCell(
  id: string,
  options: {
    artifact?: ToolArtifact;
    fileOp?: ToolNode['fileOp'];
    phase?: 'ok' | 'failed';
  } = {},
): ToolNode {
  const artifacts = options.artifact
    ? projectToolArtifacts([options.artifact], { params: {} })
    : undefined;
  return {
    kind: 'tool',
    id,
    ts: 0,
    sourceIndex: -1,
    titleKey: '编辑文件',
    tone: 'neutral',
    interaction: 'expand',
    defaultExpanded: false,
    summaryDuplicatesDetail: false,
    tool: 'edit',
    state: options.phase === 'failed'
      ? { phase: 'failed', error: '失败' }
      : { phase: 'ok' },
    actions: [],
    ...(options.fileOp ? { fileOp: options.fileOp } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}

function must(change: FileChange | null): FileChange {
  if (!change) throw new Error('期望有一份单次改动');
  return change;
}

describe('单次改动的行号口径', () => {
  it('带 review artifact 的 edit：用权威 diff，absoluteLines: true，行号真实', () => {
    const change = must(fileChangeOf(editCell('c-1', {
      artifact: diffArtifact('/w/app.txt', 42, 'old-line', 'new-line'),
      fileOp: { kind: 'edit', path: '/w/app.txt', oldText: 'old-line', newText: 'new-line', replaceAll: true },
    })));

    expect(change.path).toBe('/w/app.txt');
    expect(change.kind).toBe('edit');
    expect(change.absoluteLines).toBe(true);
    expect(change.replaceAll).toBe(true);   // replaceAll 仍从 fileOp 参数取
    expect(change.diff.lines).toMatchObject([
      { kind: 'remove', text: 'old-line', oldNo: 42 },
      { kind: 'add', text: 'new-line', newNo: 42 },
    ]);
    expect(change.stat).toEqual({ added: 1, removed: 1 });
  });

  it('无 artifact 的 edit：维持参数 LCS 重建兜底，absoluteLines: false', () => {
    const change = must(fileChangeOf(editCell('c-1', {
      fileOp: { kind: 'edit', path: '/w/app.txt', oldText: 'old-line\n', newText: 'new-line\n', replaceAll: false },
    })));

    expect(change.absoluteLines).toBe(false);
    expect(change.stat).toEqual({ added: 1, removed: 1 });
  });

  it('失败的 cell 即使带 artifact 也解读为 null', () => {
    expect(fileChangeOf(editCell('c-1', {
      artifact: diffArtifact('/w/app.txt', 1, 'a', 'b'),
      phase: 'failed',
    }))).toBeNull();
  });

  it('同文件的两条 edit 各自独立解读，行号互不牵连', () => {
    const first = must(fileChangeOf(editCell('c-1', { artifact: diffArtifact('/w/app.txt', 10, 'x', 'y') })));
    const second = must(fileChangeOf(editCell('c-2', { artifact: diffArtifact('/w/app.txt', 50, 'y', 'z') })));

    expect(first.diff.lines[0]).toMatchObject({ oldNo: 10 });
    expect(second.diff.lines[0]).toMatchObject({ oldNo: 50 });
  });

  it('write 全量路径：无 artifact 也是 absoluteLines: true', () => {
    const change = must(fileChangeOf(editCell('c-1', {
      fileOp: { kind: 'write', path: '/w/new.txt', content: 'a\nb\n' },
    })));

    expect(change.kind).toBe('write');
    expect(change.absoluteLines).toBe(true);
  });
});
