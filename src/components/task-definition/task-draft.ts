/**
 * TaskDraft —— 创建自定义任务的草稿模型。
 *
 * 纯数据 + 纯函数，与 UI 完全解耦：弹层只负责把控件绑到 `draftReducer` 的
 * patch 上，校验（`draftDefect`）与后端入参构造（`draftToTaskDefinitionInput`）都在
 * 这里完成，可单测。
 *
 * MCP 能力上界用 `'all' | 有序白名单` 表达：'all' 提交时映射为
 * `mcpServers: undefined`（不设上界）；空数组是「刻意全部禁用」，二者语义不同。
 */

import type {
  TaskDefinitionCreateInput,
  TaskDefinitionSnapshot,
  TaskDefinitionUpdateInput,
} from '../../../shared/electron-contracts/task-definitions';
import {
  buildStandardTaskBindings,
  getTaskDefinitionEnvironmentIds,
} from '../../utils/taskDefinitionBindings';

export interface TaskDraft {
  readonly name: string;
  /** 普通任务的描述（IM 模式下不采用） */
  readonly brief: string;
  /** IM 模式的系统提示词 */
  readonly charter: string;
  readonly mode: 'plan' | 'normal';
  readonly approval: 'confirm' | 'auto';
  readonly im: boolean;
  /** 绑定的浏览器环境 id（有序） */
  readonly envIds: readonly string[];
  /** MCP 能力上界：'all' = 使用全部生效项；数组 = 有序白名单 */
  readonly mcp: 'all' | readonly string[];
  readonly workspace?: string;
  /** undefined = 跟随默认；显式拨动过才写入 advancedSettings */
  readonly background?: boolean;
}

export function blankDraft(im: boolean): TaskDraft {
  return {
    name: '',
    brief: '',
    charter: '',
    mode: 'normal',
    approval: im ? 'auto' : 'confirm',
    im,
    envIds: [],
    mcp: 'all',
  };
}

export function draftFromTaskDefinition(definition: TaskDefinitionSnapshot): TaskDraft {
  const im = definition.purpose === 'messaging';
  return {
    name: definition.name,
    brief: definition.promptTemplate,
    charter: definition.systemPrompt ?? '',
    mode: definition.defaultModeId,
    approval: im ? 'auto' : definition.defaultApprovalMode,
    im,
    envIds: getTaskDefinitionEnvironmentIds(definition),
    mcp: definition.mcpServers === undefined ? 'all' : [...definition.mcpServers],
    workspace: definition.workspace,
    background: definition.advancedSettings?.backgroundMode,
  };
}

export type DraftAction =
  | { readonly kind: 'reset'; readonly draft: TaskDraft }
  | { readonly kind: 'patch'; readonly patch: Partial<TaskDraft> };

export function draftReducer(draft: TaskDraft, action: DraftAction): TaskDraft {
  if (action.kind === 'reset') return action.draft;
  const next: TaskDraft = { ...draft, ...action.patch };
  // 开 IM 即锁自动审批：IM 会话无人守屏，逐步确认会把任务卡死
  if (action.patch.im === true && next.approval !== 'auto') {
    return { ...next, approval: 'auto' };
  }
  return next;
}

/** 提交前校验：返回第一处缺陷；null = 可提交 */
export type DraftDefect = 'name' | 'brief';

export function draftDefect(draft: TaskDraft): DraftDefect | null {
  if (!draft.name.trim()) return 'name';
  if (!draft.im && !draft.brief.trim()) return 'brief';
  return null;
}

/** 白名单内元素上/下移一位；越界原样返回 */
export function nudgeMcp(
  list: readonly string[],
  index: number,
  offset: -1 | 1,
): readonly string[] {
  const target = index + offset;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function draftToTaskDefinitionInput(draft: TaskDraft): TaskDefinitionCreateInput {
  const charter = draft.charter.trim();
  const brief = draft.brief.trim();
  return {
    name: draft.name.trim(),
    description: `${(draft.im ? charter : brief).substring(0, 100)}...`,
    category: 'custom',
    purpose: draft.im ? 'messaging' : 'general',
    promptTemplate: draft.im ? '' : brief,
    systemPrompt: draft.im && charter ? charter : undefined,
    advancedSettings:
      draft.background !== undefined ? { backgroundMode: draft.background } : undefined,
    metadata: buildStandardTaskBindings(draft.envIds),
    defaultModeId: draft.mode,
    defaultApprovalMode: draft.im ? 'auto' : draft.approval,
    workspace: draft.workspace,
    mcpServers: draft.mcp === 'all' ? undefined : [...draft.mcp],
  };
}

export function draftToTaskDefinitionUpdateInput(
  draft: TaskDraft,
  original: TaskDefinitionSnapshot,
): TaskDefinitionUpdateInput {
  const input = draftToTaskDefinitionInput(draft);
  const advancedSettings = {
    ...original.advancedSettings,
    ...(draft.background !== undefined ? { backgroundMode: draft.background } : {}),
  };

  return {
    ...input,
    category: original.category,
    systemPrompt:
      draft.im || original.purpose === 'messaging'
        ? input.systemPrompt
        : original.systemPrompt,
    advancedSettings:
      Object.keys(advancedSettings).length > 0 ? advancedSettings : undefined,
  };
}
