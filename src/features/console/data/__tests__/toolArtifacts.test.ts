/**
 * 前端 projector registry：验证各 kind 的投影正确性、
 * 固定 slot、下标配对、纯函数可重建性。
 * 「新增未注册 kind 编译失败」由 registry 的 `satisfies` 映射类型
 * 在编译期保证，属 tsc 门禁覆盖，无法也无需在运行时断言。
 */
import { describe, expect, it } from 'vitest';

import type { ToolArtifact } from '../../../../../shared/types';
import {
  materializeReviewArtifact,
  projectToolArtifacts,
  type ToolCellArtifact,
} from '../toolArtifacts';

const DIFF_ARTIFACT: ToolArtifact = {
  kind: 'file_diff',
  payload: {
    path: '/w/notes.txt',
    unifiedDiff: '--- a/notes.txt\n+++ b/notes.txt\n'
      + '@@ -40,3 +40,3 @@\n'
      + ' before\n'
      + '-old\n'
      + '+new\n',
    stat: { linesAdded: 0, linesDeleted: 0, linesChanged: 1 },
  },
};

const ANSWERS_ARTIFACT: ToolArtifact = {
  kind: 'ask_user_answers',
  payload: { answers: ['方案 A', '多行\n答案'] },
};

const TWO_QUESTIONS = {
  questions: [{ question: '选哪个方案？' }, { question: '备注？' }],
};

function projectSingle(artifact: ToolArtifact, params: unknown): ToolCellArtifact {
  const projected = projectToolArtifacts([artifact], { params });
  expect(projected).toHaveLength(1);
  const view = projected?.[0];
  if (!view) throw new Error('投影结果缺失');
  return view;
}

function asReview(view: ToolCellArtifact): Extract<ToolCellArtifact, { slot: 'review' }> {
  if (view.slot !== 'review') throw new Error(`期望 review slot，实际 ${view.slot}`);
  return view;
}

function asDetail(view: ToolCellArtifact): Extract<ToolCellArtifact, { kind: 'ask_user_answers' }> {
  if (view.kind !== 'ask_user_answers') throw new Error(`期望 ask_user_answers 投影，实际 ${view.kind}`);
  return view;
}

describe('前端 projector', () => {
  it('file_diff 只输出 review slot，行号为绝对行号、stat 从后端三向计数换算', () => {
    const view = asReview(projectSingle(DIFF_ARTIFACT, {}));

    expect(view.kind).toBe('file_diff');
    expect(view.path).toBe('/w/notes.txt');
    expect(view.backendStat).toEqual({ linesAdded: 0, linesDeleted: 0, linesChanged: 1 });
    const diff = materializeReviewArtifact(view);
    // 两向口径：added = linesAdded + linesChanged
    expect(diff.stat).toEqual({ added: 1, removed: 1 });
    expect(diff.degraded).toBe(false);
    expect(diff.lines).toMatchObject([
      { kind: 'context', text: 'before', oldNo: 40, newNo: 40 },
      { kind: 'remove', text: 'old', oldNo: 41 },
      { kind: 'add', text: 'new', newNo: 41 },
    ]);
  });

  it('ask_user_answers 只输出 tool-detail slot，Q/A 按下标生成', () => {
    const view = asDetail(projectSingle(ANSWERS_ARTIFACT, TWO_QUESTIONS));

    expect(view.kind).toBe('ask_user_answers');
    expect(view.items).toEqual([
      { question: '选哪个方案？', answer: '方案 A' },
      { question: '备注？', answer: '多行\n答案' },
    ]);
  });

  it('问题文本重复仍按下标配对，不按文本建 Map', () => {
    const dupQuestions = { questions: [{ question: '确认？' }, { question: '确认？' }] };
    const artifact: ToolArtifact = {
      kind: 'ask_user_answers',
      payload: { answers: ['第一次确认', '第二次确认'] },
    };
    const view = asDetail(projectSingle(artifact, dupQuestions));
    expect(view.items.map((item) => item.answer)).toEqual(['第一次确认', '第二次确认']);
  });

  it('params 形状损坏时不抛：问题列表缺省为空', () => {
    const view = asDetail(projectSingle(ANSWERS_ARTIFACT, null));
    expect(view.items).toEqual([]);
  });

  it('MCP 音频投影为可播放 data URL', () => {
    const audio = projectSingle({
      kind: 'mcp_audio',
      payload: { mimeType: 'audio/wav', dataBase64: 'c291bmQ=' },
    }, {});
    expect(audio).toMatchObject({
      kind: 'mcp_audio',
      mimeType: 'audio/wav',
      dataUrl: 'data:audio/wav;base64,c291bmQ=',
    });
  });

  it('缺 artifacts / 空数组 → undefined（不产生空 slot 噪声）', () => {
    expect(projectToolArtifacts(undefined, { params: {} })).toBeUndefined();
    expect(projectToolArtifacts([], { params: {} })).toBeUndefined();
  });

  it('相同输入重复投影深度相等——纯函数、无外部可变状态', () => {
    const context = { params: TWO_QUESTIONS };
    const first = projectToolArtifacts([DIFF_ARTIFACT, ANSWERS_ARTIFACT], context);
    const second = projectToolArtifacts([DIFF_ARTIFACT, ANSWERS_ARTIFACT], context);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);   // 每次都是新派生数据，不是共享缓存
    // 顺序保持输入序
    expect(first?.map((view) => view.slot)).toEqual(['review', 'tool-detail']);
  });
});
