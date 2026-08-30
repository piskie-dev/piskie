/**
 * L3 mode：按 modeId 选择单份模式碎片。
 * 仅顶层 agent 注入；worker 恒无（由 assemble() 保证）。
 * 审批模式由系统处理，不影响 AI 的业务决策。
 */

import type { PromptContext } from '../types.js';

// ─── normal ───

function normalFragment(): string {
  return `## 执行模式：普通

直接执行任务，不需要事先制定计划。
需要工具时直接调用，不要在文字中另问“是否批准/是否开始”。调用被用户拒绝时，调整方案或用 ask_user 询问，不要原样重试。`;
}

// ─── plan（模式=纯审批门；L3 只承载"此刻的纪律"） ───
// <available_skills> 匹配由 L0 规划框架承载（全模式适用，不在此重复）；
// 调查方法论（两类未知分治）与审批返回值语义由 plan 工具 description 唯一承载。

function planFragment(): string {
  return `## 执行模式：计划

制定计划提交用户审批，获批后立即按计划执行。

**澄清判据**（用 ask_user）：涉及 3 个以上网站/技能且用户未明确顺序、参数有多种合理解读、涉及不可逆操作（发布/删除/支付）未确认意图——任务明确、参数完整则不问。`;
}

// ─── browser-skill（构建目标，不是一次性网站任务） ───

function browserSkillFragment(): string {
  return `## 执行模式：Browser Skill 构建

本模式用于把用户指定网站上的操作能力构建、测试并发布为可复用的 executable Skill。用户描述的网站、操作或业务目标，是本次要固化的能力范围与验收场景，不是要求你把它作为一次普通网站任务直接替用户完成；本模式的交付物是 Browser Skill，而不是一次业务结果。

真实探索不能省略，但探索目的按范围区分：只给出网站或范围较宽时，先侦察网站的主要功能、入口、依赖和风险，再规划范围并在确有多个独立方向时请用户选择；范围已经明确时可跳过全站侦察。范围确定后先提交验收计划供用户确认，确认后再开始构建；实现前仍须深入探索目标流程。不要调用已有 Skill、普通 browser Worker 或 browser 通用工具把原始目标执行一次后结束构建。`;
}

// ─── 入口 ───

/**
 * 按 modeId 返回单份模式碎片；未知模式返回空。
 */
export function modeFragment(ctx: PromptContext): string {
  switch (ctx.modeId) {
    case 'normal':
      return normalFragment();
    case 'plan':
      return planFragment();
    case 'browser-skill':
      return browserSkillFragment();
    default:
      return '';
  }
}
