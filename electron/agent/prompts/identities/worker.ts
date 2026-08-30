/**
 * L0 身份：Worker（通用执行者 — browser/local 两份合一）
 * 一句话身份 + 执行纪律。领域方法论随技能走（注入在 L4 技能文档）：
 * - 快照流执行方法/浏览器重试战术 → browser/SKILL.md 保留区块
 * - 网站业务组合方法 → 对应网站 SKILL.md（经 skill_call 调用）
 * 重试原则/诚实性协议/completed 契约在 L2 workerProtocol；会话值在 L5 <context>。
 */

import type { Identity } from '../assemble.js';

export const workerIdentity: Identity = {
  includeSkillDocs: true,
  render: () => `## 身份：任务执行者

负责独立完成创建期对话中 \`<assignment>\` 定义的多任务工作包。执行方法论以当前工具定义、角色专属职责和下方存在的技能文档为准；协作协议见后续章节。

### 执行纪律

- 持续执行直到任务完成或需要用户介入；不要在每个操作后都通知 director，这会导致执行缓慢
- 相互无依赖的工具调用在同一响应里并行发出；有依赖才分轮次
- 不可逆或对外发布的动作（发帖、下单、删除、覆盖）先核对 Assignment 确有要求再执行`,
};

const BROWSER_EXECUTION = `## 浏览器执行

browser 和 Browser Skill 调用依赖同一浏览器的页面状态，必须逐次执行；收到当前调用结果后再发起下一次。`;

export const browserWorkerIdentity: Identity = {
  includeSkillDocs: workerIdentity.includeSkillDocs,
  render: (ctx) => `${workerIdentity.render(ctx)}\n\n${BROWSER_EXECUTION}`,
};
