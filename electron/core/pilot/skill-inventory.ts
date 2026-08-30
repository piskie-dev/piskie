import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * <available_skills> 清单构建器
 *
 * 注入时刻（agent 创建或会话恢复）从三层合并视图枚举一次，运行段内不刷新；
 * 会话恢复重新渲染并重新快照 manifest（互斥基准随之更新）。
 * 渲染与降级在 skills/discovery/inventory.ts；这里负责枚举合并视图与函数补齐。
 */

import path from 'path';
import { CORE_SKILLS } from '../../piskiepilot/core/skill/loader.js';
import { renderSkillInventory, type InventorySkill } from '../../skills/discovery/inventory.js';
import type { SearchableSkill, SkillSearchSource } from '../../skills/discovery/search.js';
import { isProjectLayerActive } from '../../skills/store/layout.js';
import type { SkillInventorySnapshot } from '../../../shared/types/skill.js';
import type { SkillCatalogPort } from './pilot-manager.js';
import { pathsService } from '../../services/paths.service.js';
/** 内置核心技能常驻工具面，不重复进入清单。 */
const EXCLUDED = new Set<string>(CORE_SKILLS);

export interface SkillInventoryResult {
  /** <available_skills> 块内文本（空清单为空串，调用方不渲染块） */
  text: string;
  /** 机读 manifest：tool_search 互斥不变量的基准 */
  snapshot: SkillInventorySnapshot;
  count: number;
}

export interface SkillInventoryOptions {
  /** 当前模型上下文窗口（token）；传入时预算 = 窗口 2%，缺省按 8000 字符 */
  contextWindowTokens?: number;
  /** AgentRunConfig.workspace；项目层按路径判据激活（显式配成缺省路径也不激活） */
  workspace?: string;
  defaultWorkspaceDir?: string;
}

export function emptySkillInventory(): SkillInventoryResult {
  return { text: '', snapshot: { renderedAt: new Date().toISOString(), entries: {} }, count: 0 };
}

/**
 * 构建已安装技能清单快照。
 * 失败降级为空清单（tool_search 兜底可检索），不阻塞 agent 启动。
 */
export async function buildSkillInventory(
  catalog: SkillCatalogPort,
  options: SkillInventoryOptions = {}
): Promise<SkillInventoryResult> {
  let items: Awaited<ReturnType<SkillCatalogPort['listManagedSkills']>>;
  try {
    const projectActive =
      options.workspace && options.defaultWorkspaceDir
        ? await isProjectLayerActive(options.workspace, options.defaultWorkspaceDir)
        : false;
    items = await catalog.listManagedSkills({
      scope: 'all',
      workspaces: projectActive && options.workspace ? [options.workspace] : undefined,
    });
  } catch (error) {
    appLog.warn({
      event: 'browser.skill_inventory.load.degraded',
      message: 'Browser skill inventory load degraded',
      context: { scope: 'browser.skill_inventory' },
      error,
    });
    return emptySkillInventory();
  }

  const skills: InventorySkill[] = [];
  for (const item of items) {
    if (!item.enabled || EXCLUDED.has(item.name)) continue;
    const functions = Object.keys(catalog.getLoadedSkillModule(item.name)?.functions ?? {});
    skills.push({
      name: item.name,
      description: item.description || '',
      scope: item.scope,
      path: path.join(catalog.getSkillResourceRoot(item.name) ?? item.path, 'SKILL.md'),
      functions,
    });
  }

  if (skills.length === 0) return emptySkillInventory();

  const rendered = renderSkillInventory(skills, {
    contextWindowTokens: options.contextWindowTokens,
  });
  return {
    text: rendered.text,
    snapshot: rendered.snapshot,
    count: skills.length - rendered.omitted.length,
  };
}

/**
 * tool_search 技能侧数据源：三层合并视图 + 函数名 + 正文（loader 可得时）。
 * 与清单不同，search 覆盖全部已启用技能（含内置核心——它们不进清单但可被检索）。
 */
export function createSkillSearchSource(catalog: SkillCatalogPort): SkillSearchSource {
  return {
    async listSearchableSkills(workspace?: string): Promise<SearchableSkill[]> {
      const projectActive = workspace
        ? await isProjectLayerActive(workspace, pathsService.getDefaultWorkspaceDir())
        : false;
      const items = await catalog.listManagedSkills({
        scope: 'all',
        workspaces: projectActive && workspace ? [workspace] : undefined,
      });
      return Promise.all(
        items
          .filter((item) => item.enabled)
          .map(async (item) => {
            const functions = Object.keys(catalog.getLoadedSkillModule(item.name)?.functions ?? {});
            let body: string | undefined;
            try {
              body = (await catalog.getSkillDocs(item.name)) || undefined;
            } catch {
              body = undefined;
            }
            return {
              name: item.name,
              description: item.description || '',
              type: item.type,
              scope: item.scope,
              path: path.join(catalog.getSkillResourceRoot(item.name) ?? item.path, 'SKILL.md'),
              functions,
              body,
            };
          })
      );
    },
  };
}

/** 从 host 解析当前模型上下文窗口（token）；解析不到返回 undefined（走缺省预算） */
export function resolveContextWindow(host: {
  currentTarget: { providerId: string; modelId: string };
  getInference(): {
    contextWindow(target: { providerId: string; modelId: string }): number | undefined;
  };
}): number | undefined {
  try {
    return host.getInference().contextWindow(host.currentTarget);
  } catch {
    return undefined;
  }
}
