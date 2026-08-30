/**
 * 生图成品路径解析的单测。钉三条：
 * 1. 只认结果文本的 `- [成功] <path>` 行（partial 时失败路径不混进来）
 * 2. 带备注（`（覆盖已有文件)`）的行剥掉备注
 * 3. 非 ok / 非 generate_image 一律 undefined
 */

import { describe, expect, it } from 'vitest';

import type { PersistedToolResultBlock, ToolEntry } from '../../../../../../shared/types/agent-control';
import { buildToolNode, resolveToolOutcome } from '../toolCell';

function entry(text: string, ok = true): ToolEntry {
  return {
    t: 'tool',
    ts: 0,
    toolUseId: 'call-1',
    ok,
    result: [{ type: 'text', text }] as PersistedToolResultBlock[],
  };
}

function build(over: { tool?: string; text: string; ok?: boolean }) {
  const resultEntry = entry(over.text, over.ok ?? true);
  return buildToolNode({
    toolUseId: 'call-1',
    ts: 0,
    sourceIndex: 0,
    tool: over.tool ?? 'generate_image',
    params: {},
    entry: resultEntry,
    outcome: resolveToolOutcome({ toolUseId: 'call-1', entry: resultEntry }),
  });
}

const OK_TEXT = [
  '图片生成完成：2 张已写入最终路径。',
  '- [成功] /out/a.png',
  '- [成功] /out/b.png（覆盖已有文件）',
].join('\n');

describe('generatedImages', () => {
  it('成功行全部解析，备注剥掉', () => {
    expect(build({ text: OK_TEXT }).generatedImages).toEqual(['/out/a.png', '/out/b.png']);
  });

  it('partial：只收成功行', () => {
    const text = ['部分成功。', '- [成功] /out/a.png', '- [失败] /out/c.png（写入失败）'].join('\n');
    expect(build({ text }).generatedImages).toEqual(['/out/a.png']);
  });

  it('失败结果不给缩略图', () => {
    expect(build({ text: '全部失败', ok: false }).generatedImages).toBeUndefined();
  });

  it('其他工具即使结果里有同样格式也不解析', () => {
    expect(build({ tool: 'shell', text: OK_TEXT }).generatedImages).toBeUndefined();
  });

  it('没有成功行 ⇒ undefined 而不是空数组', () => {
    expect(build({ text: '图片生成完成：0 张。' }).generatedImages).toBeUndefined();
  });
});
