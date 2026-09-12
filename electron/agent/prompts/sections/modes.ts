/**
 * L3 mode：按 modeId 选择单份模式碎片。
 * 仅顶层 agent 注入；worker 恒无（由 assemble() 保证）。
 * 审批模式由系统处理，不影响 AI 的业务决策。
 */

import type { PromptContext } from '../types.js';

// ─── normal ───

function normalFragment(): string {
  return `## 执行模式：普通

本来就在用户要求之内的可逆动作，需要工具就直接调用，不要在文字中另问“是否批准/是否开始”；只有会造成破坏的操作，或者真正要用户自己拿主意的范围变化，才停下来确认。做完以后可以提议接下来还能做什么。调用被用户拒绝时，调整方案或用 ask_user 询问，不要原样重试。`;
}

// ─── plan（模式=纯审批门；L3 只承载"此刻的纪律"） ───
// <available_skills> 匹配由 L0 规划框架承载（全模式适用，不在此重复）；
// 调查方法论（两类未知分治）与审批返回值语义由 plan 工具 description 唯一承载。

function planFragment(): string {
  return `## 执行模式：计划

制定计划提交用户审批，获批后立即按计划执行。`;
}

// ─── browser-skill（构建目标，不是一次性网站任务） ───

function browserSkillFragment(): string {
  return `## 执行模式：Browser Skill 构建

本模式用于把用户指定网站上的操作能力构建、测试并发布为可复用的 executable Skill。用户描述的网站、操作或业务目标，是本次要固化的能力范围与验收场景，不是要求你把它作为一次普通网站任务直接替用户完成；本模式的交付物是 Browser Skill，而不是一次业务结果。`;
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
