/**
 * 工具批次的并发分组 —— 并行模式下决定哪些 tool_use 可以一起跑。
 *
 * 判据只看工具声明的 `effects`（`ToolEffect`）：
 * - 只含 `read-fs` / `external`（含空数组）⇒ 并发安全；
 * - 含 `write-fs` / `exec` / `agent-control` ⇒ 不安全，单独成组按发出顺序执行。
 *
 * 为什么要串行写类工具：同文件的两个 edit 并发时都以原文为基准计算，后提交的覆盖
 * 先提交的；ReadLedger 的版本令牌被第一个写入更新，第二个看到的是"current"，检测不到
 * 自我竞争。串行后第二个 edit 直接在第一个的输出上匹配。`shell` 声明 `exec` 但同样能
 * 改文件，一并串行。与 Claude Code 的 isConcurrencySafe 分批一致。
 *
 * 目录里解析不到的工具名视为安全：协调器会以"未知工具"打回，没有副作用，串行毫无收益。
 * `skill_call` 是选择器，按 skill/function 解析到实际函数再看它的 effects。
 */

import type { CatalogSnapshot } from '../../tools/catalog.js';
import type { ToolEffect } from '../../tools/types.js';
import type { ContentBlock } from '../../../shared/types/index.js';

const CONCURRENCY_SAFE_EFFECTS: ReadonlySet<ToolEffect> = new Set<ToolEffect>(['read-fs', 'external']);

function declaredEffects(
  toolUse: ContentBlock,
  snapshot: CatalogSnapshot,
  loadedDeferredTools: ReadonlySet<string>,
): readonly ToolEffect[] | undefined {
  const name = toolUse.name;
  if (!name) return undefined;
  const entry = snapshot.resolve(name)
    ?? (loadedDeferredTools.has(name) ? snapshot.resolveDeferred(name) : undefined);
  if (!entry) return undefined;
  if (name !== 'skill_call') return entry.tool.def.effects;

  const input = (toolUse.input ?? {}) as Record<string, unknown>;
  const skill = input.skill;
  const functionName = input.function;
  if (typeof skill !== 'string' || typeof functionName !== 'string') return undefined;
  const resolved = snapshot.resolveSkillFunction(skill, functionName);
  return resolved.kind === 'resolved' ? resolved.entry.tool.def.effects : undefined;
}

export function isConcurrencySafe(
  toolUse: ContentBlock,
  snapshot: CatalogSnapshot,
  loadedDeferredTools: ReadonlySet<string>,
): boolean {
  const effects = declaredEffects(toolUse, snapshot, loadedDeferredTools);
  if (!effects) return true;
  return effects.every((effect) => CONCURRENCY_SAFE_EFFECTS.has(effect));
}

/**
 * 按发出顺序分组：连续的并发安全调用合成一组，不安全调用各自成组。
 * 组内并行、组间串行，tool_result 的落盘顺序因此与发出顺序一致。
 */
export function groupByConcurrencySafety<T>(
  items: readonly T[],
  isSafe: (item: T) => boolean,
): T[][] {
  const groups: T[][] = [];
  let safeRun: T[] | null = null;
  for (const item of items) {
    if (isSafe(item)) {
      if (!safeRun) {
        safeRun = [];
        groups.push(safeRun);
      }
      safeRun.push(item);
      continue;
    }
    safeRun = null;
    groups.push([item]);
  }
  return groups;
}
