import { describe, expect, it } from 'vitest';

import type { TaskDefinitionSnapshot } from '../../../../shared/electron-contracts/task-definitions';
import {
  blankDraft,
  draftDefect,
  draftFromTaskDefinition,
  draftReducer,
  draftToTaskDefinitionInput,
  draftToTaskDefinitionUpdateInput,
  nudgeMcp,
} from '../task-draft';

describe('draftReducer', () => {
  it('开启 IM 时把审批锁到 auto', () => {
    const next = draftReducer(blankDraft(false), { kind: 'patch', patch: { im: true } });
    expect(next.approval).toBe('auto');
  });

  it('普通 patch 不改无关字段', () => {
    const next = draftReducer(blankDraft(false), { kind: 'patch', patch: { name: 'x' } });
    expect(next.name).toBe('x');
    expect(next.approval).toBe('confirm');
  });
});

describe('draftDefect', () => {
  it('名称必填', () => {
    expect(draftDefect(blankDraft(false))).toBe('name');
  });

  it('非 IM 模式描述必填；IM 模式不要求描述', () => {
    const named = { ...blankDraft(false), name: 't' };
    expect(draftDefect(named)).toBe('brief');
    expect(draftDefect({ ...blankDraft(true), name: 't' })).toBeNull();
  });
});

describe('nudgeMcp', () => {
  it('上移/下移交换相邻项', () => {
    expect(nudgeMcp(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(nudgeMcp(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  });

  it('越界原样返回', () => {
    const list = ['a', 'b'];
    expect(nudgeMcp(list, 0, -1)).toBe(list);
    expect(nudgeMcp(list, 1, 1)).toBe(list);
  });
});

describe('draftToTaskDefinitionInput', () => {
  it('IM 草稿：空 promptTemplate + charter 作为 systemPrompt + 强制 auto 审批', () => {
    const input = draftToTaskDefinitionInput({
      ...blankDraft(true),
      name: ' 客服 ',
      charter: ' 你是客服 ',
      approval: 'confirm',
    });
    expect(input.name).toBe('客服');
    expect(input.purpose).toBe('messaging');
    expect(input.promptTemplate).toBe('');
    expect(input.systemPrompt).toBe('你是客服');
    expect(input.defaultApprovalMode).toBe('auto');
  });

  it('普通草稿：brief 进 promptTemplate，mcp all 映射为 undefined', () => {
    const input = draftToTaskDefinitionInput({
      ...blankDraft(false),
      name: 't',
      brief: '订机票',
    });
    expect(input.purpose).toBe('general');
    expect(input.promptTemplate).toBe('订机票');
    expect(input.systemPrompt).toBeUndefined();
    expect(input.mcpServers).toBeUndefined();
    expect(input.advancedSettings).toBeUndefined();
    expect(input.metadata).toBeUndefined();
  });

  it('浏览器环境绑定按 typed draft 去重，保持首次出现顺序', () => {
    const input = draftToTaskDefinitionInput({
      ...blankDraft(false),
      name: 't',
      brief: 'x',
      envIds: ['env-b', 'env-a', 'env-b'],
    });

    expect(input.metadata).toEqual({
      type: 'standard',
      boundEnvironmentIds: ['env-b', 'env-a'],
    });
  });

  it('白名单与显式后台开关原样带出', () => {
    const input = draftToTaskDefinitionInput({
      ...blankDraft(false),
      name: 't',
      brief: 'x',
      mcp: ['b', 'a'],
      background: false,
    });
    expect(input.mcpServers).toEqual(['b', 'a']);
    expect(input.advancedSettings).toEqual({ backgroundMode: false });
  });
});

describe('任务模板编辑草稿', () => {
  const definition: TaskDefinitionSnapshot = {
    definitionId: 'td-existing',
    name: '运营日报',
    description: '汇总日报...',
    category: '运营',
    purpose: 'general',
    promptTemplate: '汇总日报',
    systemPrompt: '保留这条未在普通简报中展示的系统提示词',
    defaultModeId: 'plan',
    defaultApprovalMode: 'auto',
    workspace: '/workspace/ops',
    metadata: { type: 'standard', boundEnvironmentIds: ['env-b', 'env-a'] },
    advancedSettings: { language: 'zh-CN', backgroundMode: false },
    mcpServers: ['search', 'docs'],
    createdAt: '2026-08-22T00:00:00.000Z',
  };

  it('从快照回填全部可编辑字段', () => {
    expect(draftFromTaskDefinition(definition)).toEqual({
      name: '运营日报',
      brief: '汇总日报',
      charter: '保留这条未在普通简报中展示的系统提示词',
      mode: 'plan',
      approval: 'auto',
      im: false,
      envIds: ['env-b', 'env-a'],
      mcp: ['search', 'docs'],
      workspace: '/workspace/ops',
      background: false,
    });
  });

  it('从快照读取环境绑定时去重', () => {
    const draft = draftFromTaskDefinition({
      ...definition,
      metadata: {
        type: 'standard',
        boundEnvironmentIds: ['env-b', 'env-a', 'env-b'],
      },
    });

    expect(draft.envIds).toEqual(['env-b', 'env-a']);
  });

  it('保存编辑字段时保留未暴露的分类、高级设置和普通任务系统提示词', () => {
    const draft = {
      ...draftFromTaskDefinition(definition),
      name: '运营周报',
      brief: '汇总本周数据',
      background: true,
    };

    expect(draftToTaskDefinitionUpdateInput(draft, definition)).toMatchObject({
      name: '运营周报',
      description: '汇总本周数据...',
      category: '运营',
      purpose: 'general',
      promptTemplate: '汇总本周数据',
      systemPrompt: '保留这条未在普通简报中展示的系统提示词',
      defaultModeId: 'plan',
      defaultApprovalMode: 'auto',
      workspace: '/workspace/ops',
      metadata: { type: 'standard', boundEnvironmentIds: ['env-b', 'env-a'] },
      advancedSettings: { language: 'zh-CN', backgroundMode: true },
      mcpServers: ['search', 'docs'],
    });
  });

  it('消息模板按 purpose 回填 IM 简报', () => {
    const draft = draftFromTaskDefinition({
      ...definition,
      purpose: 'messaging',
      promptTemplate: '',
      systemPrompt: '你是客服',
      defaultApprovalMode: 'confirm',
    });

    expect(draft.im).toBe(true);
    expect(draft.charter).toBe('你是客服');
    expect(draft.approval).toBe('auto');
  });
});
