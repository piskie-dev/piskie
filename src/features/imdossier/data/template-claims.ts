/**
 * 任务模板认领视图（双玻璃名册档案 · 绑定排他）。
 *
 * 语义:一个 TaskDefinition 只能绑一个 Bot(远端 task-definition-options 行为)。
 * 为绑定下拉产出「谁占了哪个模板」的视图:被其他 Bot 占用的选项 disabled
 * 并标注占用者;自己占用的不锁(允许保持现绑)。最新创建的模板排前。
 */

import type { MessagingConnectionState } from '../../../../shared/electron-contracts/messaging';
import type { TaskDefinitionPurpose } from '../../../../shared/types';

export interface TemplateClaim {
  id: string;
  name: string;
  /** 占用该模板的 Bot 名称(排他语义下至多 1 个,类型上兼容异常数据) */
  holders: string[];
  /** 被自己以外的 Bot 占用 → 选项置灰 */
  lockedByOther: boolean;
}

export interface TemplateLike {
  definitionId: string;
  name: string;
  purpose: TaskDefinitionPurpose;
  createdAt?: string;
}

export function claimTemplateOptions(
  templates: readonly TemplateLike[],
  bots: readonly MessagingConnectionState[],
  selfBotId?: string | null,
): TemplateClaim[] {
  const holdersOf = new Map<string, string[]>();
  for (const bot of bots) {
    const bound = bot.config.definitionId;
    if (!bound) continue;
    if (selfBotId && bot.config.id === selfBotId) continue;
    const list = holdersOf.get(bound) ?? [];
    list.push(bot.config.name);
    holdersOf.set(bound, list);
  }

  return [...templates]
    .filter((template) => template.purpose === 'messaging')
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .map((template) => {
      const holders = holdersOf.get(template.definitionId) ?? [];
      return {
        id: template.definitionId,
        name: template.name,
        holders,
        lockedByOther: holders.length > 0,
      };
    });
}
