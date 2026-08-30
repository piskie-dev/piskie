/**
 * L5 <context>：XML 动态块（永远在提示词最后，运行时变量的唯一出口）
 * 规则：只包运行时变量；正文引用统一为"见 <session_config>"等稳定标签名；
 * 占位符（<PARENT_ID> 之类）全部废除——这里渲染的就是真实值。
 */

import type { PromptContext } from './types.js';

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 原文块闭合标签中和：task 等长文本块不做全量 XML 转义
 * （内容是给模型读的正文，转义反而伤可读性），仅中和内容里的闭合标签防提前闭合信封。
 */
export function neutralizeClosing(tag: string, text: string): string {
  return text.replace(new RegExp(`</${tag}>`, 'g'), `<\\/${tag}>`);
}

export function renderContext(ctx: PromptContext): string {
  const isWorker = ctx.role === 'worker';
  const blocks: string[] = [];

  // <session_config>
  const cfg: string[] = [];
  cfg.push(`  <agent_id>${xmlEscape(ctx.agentId)}</agent_id>`);
  if (!isWorker && ctx.runName) {
    cfg.push(`  <run_name>${xmlEscape(ctx.runName)}</run_name>`);
  }
  if (ctx.skills && ctx.skills.length > 0) {
    cfg.push(`  <skills>${xmlEscape(ctx.skills.join(', '))}</skills>`);
  }
  if (cfg.length > 0) {
    blocks.push(`<session_config>\n${cfg.join('\n')}\n</session_config>`);
  }

  // <environment>（平台事实：local worker 选 bash/powershell 语法的依据）
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  blocks.push(`<environment os="${process.platform}" shell="${shell}"/>`);

  // <current_time>（时间锚点；只到日期粒度——细粒度时间戳在事件信封的 ts 属性，
  // 日粒度让系统提示词在一天内保持字节稳定，不破坏 prompt cache 前缀）
  blocks.push(`<current_time>${new Date().toISOString().slice(0, 10)}</current_time>`);

  // <file_system>
  blocks.push(`<file_system>\n  <workspace>${xmlEscape(ctx.workspaceDir)}</workspace>\n  <temp_dir>${xmlEscape(ctx.tempDir)}</temp_dir>\n</file_system>`);

  // <browser_environments>（仅绑定环境池的 director；ID 是 subagent.browserEnvironmentId 唯一合法来源）
  if (!isWorker && ctx.boundEnvironments && ctx.boundEnvironments.length > 0) {
    const environments = ctx.boundEnvironments.map((environment) =>
      `  <environment id="${xmlEscape(environment.id)}" name="${xmlEscape(environment.name)}">${xmlEscape(environment.purpose)}</environment>`,
    ).join('\n');
    blocks.push(`<browser_environments>\n${environments}\n</browser_environments>`);
  }

  // <available_skills>（仅顶层：已安装技能清单，注入时刻快照，含降级/别名/触发规则）
  if (!isWorker && ctx.availableSkillsBlock) {
    blocks.push(`<available_skills>\n${ctx.availableSkillsBlock}\n</available_skills>`);
  }

  // <mcp_tools>（main/worker 各自授权快照：deferred 名字行 + 直注 server 使用说明）
  if (ctx.mcpBlock) {
    blocks.push(`<mcp_tools>\n${ctx.mcpBlock}\n</mcp_tools>`);
  }

  return blocks.join('\n\n');
}
