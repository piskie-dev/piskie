/**
 * 唯一组装入口 assemble(identity, ctx) — 固定分层，顺序恒定
 *
 * L0 identity            通用身份+可选领域增量
 * L1 policies            全员纪律：用户沟通 + 数据边界 + 文件系统
 * L2 collaboration       协作协议（worker ↔ 顶层 二选一）
 * <user_instructions>    用户自定义指令槽位（可覆盖身份措辞与协作细节，
 *                        但 L3 模式纪律与 L5 运行时事实在其后压轴）
 * L3 mode                单份模式碎片（仅顶层且 modeId 存在；worker 恒无）
 * L4 skill-notes         技能/工具文档（由 identity 声明是否注入）
 * L5 <context>           XML 动态块（永远最后，运行时变量唯一出口）
 */

import type { PromptContext } from './types.js';
import { policies } from './sections/policies.js';
import { directorProtocol, workerProtocol } from './sections/collaboration.js';
import { modeFragment } from './sections/modes.js';
import { skillNotes } from './skill-notes.js';
import { renderContext, neutralizeClosing } from './context.js';

/** L0 身份定义 */
export interface Identity {
  /** 是否注入 L4 技能文档 */
  includeSkillDocs: boolean;
  /** 渲染身份+方法论片段 */
  render: (ctx: PromptContext) => string;
}

function userInstructions(ctx: PromptContext): string {
  if (!ctx.userInstructions) return '';
  // 原文注入（用户指令是给模型读的正文），仅中和闭合标签防提前闭合槽位
  return `<user_instructions>\n${neutralizeClosing('user_instructions', ctx.userInstructions)}\n</user_instructions>`;
}

export function assemble(identity: Identity, ctx: PromptContext): string {
  const isWorker = ctx.role === 'worker';

  const parts: string[] = [
    identity.render(ctx),                                        // L0
    policies(),                                                  // L1
    isWorker ? workerProtocol() : directorProtocol(),            // L2
    userInstructions(ctx),                                       // <user_instructions>
    !isWorker && ctx.modeId ? modeFragment(ctx) : '',          // L3
    identity.includeSkillDocs ? skillNotes(ctx.skillDocs) : '',  // L4
    renderContext(ctx),                                          // L5
  ];

  return parts.filter(Boolean).join('\n\n');
}
