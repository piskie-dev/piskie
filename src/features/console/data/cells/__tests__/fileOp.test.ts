/**
 * 文件操作载荷抽取的单测。
 *
 * 两个易错点专门固定住：
 * 1. `new_string` **允许为空串**（纯删除），不能用真值判定把它当缺参数；
 * 2. `read` 的返回是「6 位行号 + TAB」逐行拼接，末尾可能追加不带行号的提示行 ——
 *    提示不能被当成文件内容。
 */

import { describe, expect, it } from 'vitest';

import { rawText } from '../../presentationText';
import { extractFileOp, isMutation } from '../fileOp';

/** `numberLine` 的形状：6 位右对齐 + TAB（`electron/tools/fs/_lib/line-numbers.ts`） */
function numbered(startLine: number, ...lines: string[]): string {
  return lines.map((line, index) => `${String(startLine + index).padStart(6, ' ')}\t${line}`).join('\n');
}

describe('extractFileOp · edit', () => {
  it('取出 old/new 与 replace_all', () => {
    const op = extractFileOp({
      tool: 'edit',
      params: { file_path: '/a/b.ts', old_string: 'x', new_string: 'y', replace_all: true },
      ok: true,
    });

    expect(op).toEqual({
      kind: 'edit',
      path: '/a/b.ts',
      oldText: 'x',
      newText: 'y',
      replaceAll: true,
    });
  });

  it('new_string 为空串（纯删除）仍然成立', () => {
    const op = extractFileOp({
      tool: 'edit',
      params: { file_path: '/a/b.ts', old_string: 'x', new_string: '' },
      ok: true,
    });

    expect(op?.kind).toBe('edit');
    expect(op && 'newText' in op ? op.newText : undefined).toBe('');
  });

  it('缺 old_string ⇒ 不产出（宁可不显示也不显示半个）', () => {
    expect(
      extractFileOp({ tool: 'edit', params: { file_path: '/a/b.ts', new_string: 'y' }, ok: true }),
    ).toBeUndefined();
  });
});

describe('extractFileOp · write', () => {
  it('取出全量内容', () => {
    const op = extractFileOp({
      tool: 'write',
      params: { file_path: '/a/b.ts', content: 'l1\nl2' },
      ok: true,
    });

    expect(op).toEqual({ kind: 'write', path: '/a/b.ts', content: 'l1\nl2' });
  });

  it('空文件（content 为空串）仍然成立', () => {
    const op = extractFileOp({ tool: 'write', params: { file_path: '/a/b', content: '' }, ok: true });
    expect(op?.kind).toBe('write');
  });
});

describe('extractFileOp · read', () => {
  it('剥掉行号前缀，并记住真实起始行号', () => {
    const op = extractFileOp({
      tool: 'read',
      params: { file_path: '/a/b.ts', offset: 10 },
      resultText: numbered(10, 'const a = 1;', 'const b = 2;'),
      ok: true,
    });

    expect(op).toEqual({
      kind: 'read',
      path: '/a/b.ts',
      content: 'const a = 1;\nconst b = 2;',
      startLine: 10,
    });
  });

  it('末尾的提示行不进内容', () => {
    const text = [
      numbered(1, 'line one', 'line two'),
      '',
      '已显示 1-2 行（共 900 行）。继续读：read({...})',
    ].join('\n');

    const op = extractFileOp({ tool: 'read', params: { file_path: '/a/b' }, resultText: text, ok: true });

    expect(op && 'content' in op ? op.content : undefined).toBe('line one\nline two');
  });

  it('保留内容里的空行', () => {
    const op = extractFileOp({
      tool: 'read',
      params: { file_path: '/a/b' },
      resultText: numbered(1, 'a', '', 'b'),
      ok: true,
    });

    expect(op && 'content' in op ? op.content : undefined).toBe('a\n\nb');
  });

  it('二进制 / 不支持的媒体 ⇒ unreadable 带上后端原文（含 mime 与大小）', () => {
    const message =
      '/a/pic.pdf 存在（application/pdf，2.1 MB），但 read 只能向模型返回文本或 PNG/JPEG/GIF/WEBP 图片。';
    const op = extractFileOp({
      tool: 'read',
      params: { file_path: '/a/pic.pdf' },
      resultText: message,
      ok: false,
    });

    expect(op).toEqual({ kind: 'read', path: '/a/pic.pdf', unreadable: rawText(message) });
  });

  it('读取失败（文件不存在）也给 unreadable，不当成空内容', () => {
    const op = extractFileOp({
      tool: 'read',
      params: { file_path: '/nope' },
      resultText: 'File not found: /nope',
      ok: false,
    });

    expect(op && 'unreadable' in op ? op.unreadable : undefined)
      .toEqual(rawText('File not found: /nope'));
    expect(op && 'content' in op ? op.content : undefined).toBeUndefined();
  });

  it('成功但没有任何带行号的行（空文件提示）⇒ 不装作能预览', () => {
    const op = extractFileOp({
      tool: 'read',
      params: { file_path: '/a/empty' },
      resultText: '(文件为空或 offset 1 已超过文件末尾)',
      ok: true,
    });

    expect(op && 'content' in op ? op.content : undefined).toBeUndefined();
    expect(op && 'unreadable' in op ? op.unreadable : undefined)
      .toEqual(rawText('(文件为空或 offset 1 已超过文件末尾)'));
  });
});

describe('extractFileOp · 其它', () => {
  it('非文件工具不产出', () => {
    expect(extractFileOp({ tool: 'shell', params: { command: 'ls' }, ok: true })).toBeUndefined();
  });

  it('参数里没有路径不产出', () => {
    expect(extractFileOp({ tool: 'write', params: { content: 'x' }, ok: true })).toBeUndefined();
  });

  it('params 不是对象不产出（不抛）', () => {
    expect(extractFileOp({ tool: 'write', params: 'nope', ok: true })).toBeUndefined();
    expect(extractFileOp({ tool: 'write', params: null, ok: true })).toBeUndefined();
  });

  it('兼容 path 作为参数名（部分工具用 path 而非 file_path）', () => {
    const op = extractFileOp({ tool: 'write', params: { path: '/a/b', content: 'x' }, ok: true });
    expect(op?.path).toBe('/a/b');
  });
});

describe('isMutation', () => {
  it('只有 write / edit 算改动', () => {
    expect(isMutation({ kind: 'write', path: '/a', content: '' })).toBe(true);
    expect(isMutation({ kind: 'edit', path: '/a', oldText: 'a', newText: 'b', replaceAll: false })).toBe(true);
    expect(isMutation({ kind: 'read', path: '/a', content: 'x' })).toBe(false);
  });
});
