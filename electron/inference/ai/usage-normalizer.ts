/**
 * 全仓唯一对 token 做加法的地方。
 *
 * 为什么必须收在一处：同一组字段名在不同 provider 下语义相反——Anthropic 的
 * `input_tokens` 把缓存读写排除在外（要相加），OpenAI 的 `cached_tokens` 是
 * `prompt_tokens`/`input_tokens` 的明细（不得相加）。让每个 driver「各自算对」
 * 是三个互相看不见的加号，与出错前的形态同构，只是那次凑巧都对。
 *
 * 所以：字段抽取留在 driver（那里才有 SDK 类型），语义判断收进这里，
 * driver 只声明 `CacheAccounting` 这一个可以查文档核实的事实。
 */

import type { AiUsage } from './contracts.js';

export type CacheAccounting =
  /** 缓存量在计费输入之外，需相加（Anthropic Messages） */
  | 'cache-excluded'
  /** 缓存量是计费输入的明细，不得相加（OpenAI Responses / Chat Completions） */
  | 'cache-included';

export interface RawUsageParts {
  /** provider 计费口径的输入量 */
  billedInput?: number;
  /** 命中缓存读取的部分 */
  cacheRead?: number;
  /** 写入缓存的部分 */
  cacheWrite?: number;
  /** provider 口径的输出量 */
  output?: number;
  /** 思考 token（含在 output 内，仅作明细） */
  reasoning?: number;
}

/**
 * 唯一构造 `AiUsage` 的出口。此文件之外不得出现 `AiUsage` 的对象字面量
 * （门禁：`grep ": AiUsage = {\|): AiUsage {" electron/inference/`）。
 */
export function normalizeUsage(accounting: CacheAccounting, raw: RawUsageParts): AiUsage {
  const totalInput = computeTotalInput(accounting, raw);
  return {
    ...(totalInput !== undefined && { totalInputTokens: totalInput }),
    ...(raw.output !== undefined && { totalOutputTokens: raw.output }),
    ...(raw.cacheRead !== undefined && { cachedInputTokens: raw.cacheRead }),
    ...(raw.cacheWrite !== undefined && { cacheWriteTokens: raw.cacheWrite }),
    ...(raw.reasoning !== undefined && { reasoningTokens: raw.reasoning }),
  };
}

function computeTotalInput(accounting: CacheAccounting, raw: RawUsageParts): number | undefined {
  if (raw.billedInput === undefined) return undefined;
  if (accounting === 'cache-included') return raw.billedInput;
  return raw.billedInput + (raw.cacheRead ?? 0) + (raw.cacheWrite ?? 0);
}
