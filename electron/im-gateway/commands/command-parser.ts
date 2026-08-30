/**
 * IM 命令语法解析——只解析语法，不含业务
 *
 * 调用方保证文本已经过渠道 mention 清理和 trim()，且在群 sender 信封
 * 添加前执行。解析规则：
 * - 只有整条消息以 `/` 开头才可能是命令；普通文本中包含 `/clear` 不触发
 * - 首个空白分隔 token 去掉 `/` 后为命令名，其余 token 为 args
 * - 命令名匹配大小写不敏感（parser 统一定义），args 原样保留
 * - 只有完整命中已注册命令（含 alias）才返回 ParsedIMCommand；
 *   未注册的 `/foo` 返回 null，保持普通用户文本，不被静默吞掉
 */

import type { IMCommandHandler, ParsedIMCommand } from './command-types.js';

export function parseRegisteredCommand(
  text: string,
  handlers: ReadonlyMap<string, IMCommandHandler>,
): ParsedIMCommand | null {
  if (!text.startsWith('/')) return null;
  const tokens = text.split(/\s+/).filter(Boolean);
  const name = tokens[0].slice(1).toLowerCase();
  if (!name || !handlers.has(name)) return null;
  return { name, args: tokens.slice(1), raw: text };
}

/** 注册键归一化：命令名/alias 统一小写，与解析侧的大小写不敏感规则一致 */
export function normalizeCommandKey(name: string): string {
  return name.toLowerCase();
}
