/**
 * assemble() 渲染快照测试
 * 断言组装规则不变式：worker 无 mode 段、L5 标签完整、normal 不含 plan 工具用法等
 */
import { describe, it, expect } from 'vitest';
import { assemble } from '../assemble.js';
import type { PromptContext } from '../types.js';
import { directorIdentity, workerIdentity } from '../identities/index.js';
import { browserSkillBuilderIdentity } from '../browser-skill/builder.js';
import { renderBrowserSkillAuthoringGuide } from '../browser-skill/authoring-guide.js';
import { browserSkillDirectorIdentity } from '../browser-skill/director.js';
import { renderBrowserSkillSdkReference } from '../browser-skill/sdk-reference.js';
import { siteScoutIdentity } from '../browser-skill/scout.js';
import { browserSkillVerifierIdentity } from '../browser-skill/verifier.js';

function directorCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentId: 'main-1',
    role: 'director',
    flowName: '测试流程',
    canManageAgentRuns: false,
    skillDocs: '（测试技能文档）',
    workspaceDir: '/ws',
    tempDir: '/tmp/t',
    ...overrides,
  };
}

function workerCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentId: 'worker-1',
    role: 'worker',
    flowName: '子任务',
    canManageAgentRuns: false,
    skillDocs: '（测试技能文档）',
    workspaceDir: '/ws',
    tempDir: '/tmp/t',
    skills: [],
    ...overrides,
  };
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

describe('assemble L0-L5 组装规则', () => {
  it('worker 恒无 L3 模式段（即使 ctx 误带 modeId）', () => {
    const prompt = assemble(workerIdentity, workerCtx({ modeId: 'plan', approvalMode: 'confirm' }));
    expect(prompt).not.toContain('## 执行模式');
  });

  it('顶层无 modeId 时不渲染 L3（预览缺省）', () => {
    const prompt = assemble(directorIdentity, directorCtx());
    expect(prompt).not.toContain('## 执行模式');
  });

  it('顶层 normal 不向 AI 暴露 confirm/auto 差异', () => {
    const confirm = assemble(
      directorIdentity,
      directorCtx({ modeId: 'normal', approvalMode: 'confirm' })
    );
    const auto = assemble(
      directorIdentity,
      directorCtx({ modeId: 'normal', approvalMode: 'auto' })
    );
    expect(auto).toBe(confirm);
    expect(confirm).toContain('## 执行模式：普通');
    expect(confirm).not.toMatch(/confirm|auto|普通 \+ 确认|普通 \+ 自动/);
    expect(confirm).not.toContain('plan(action: "create")');
  });

  it('顶层 plan 不向 AI 暴露 confirm/auto 差异', () => {
    const confirm = assemble(
      directorIdentity,
      directorCtx({ modeId: 'plan', approvalMode: 'confirm' })
    );
    const auto = assemble(directorIdentity, directorCtx({ modeId: 'plan', approvalMode: 'auto' }));
    expect(auto).toBe(confirm);
    expect(confirm).toContain('## 执行模式：计划');
    // L3 只承载模式语义与澄清判据；工具用法字面量归 plan description。
    expect(confirm).toContain('制定计划提交用户审批');
    expect(confirm).toContain('**澄清判据**');
    expect(confirm).not.toMatch(/confirm|auto|其余工具调用自动执行/);
    expect(confirm).not.toContain('plan(action: "create")');
  });

  it('Browser Skill 模式把用户输入解释为待固化能力，并在构建前建立验收 Plan', () => {
    const prompt = assemble(
      browserSkillDirectorIdentity,
      directorCtx({
        modeId: 'browser-skill',
        approvalMode: 'confirm',
      })
    );

    expect(prompt).toContain('## 执行模式：Browser Skill 构建');
    expect(prompt).toContain('本次要固化的能力范围与验收场景');
    expect(prompt).toContain('本模式的交付物是 Browser Skill，而不是一次业务结果');
    expect(prompt).toContain('只给出网站或范围较宽时');
    expect(prompt).toContain('范围已经明确时可跳过全站侦察');
    expect(prompt).toContain('范围确定后先提交验收计划供用户确认');
    expect(prompt).not.toContain('## 执行模式：Browser Skill + 确认');
    expect(prompt).not.toContain('直接执行任务，不需要事先制定计划');
    expect(prompt).toContain('## Browser Skill 构建编排');
    expect(prompt).toContain('不能路由成替用户完成一次原始网站业务');
    expect(prompt).toContain('创建 site-scout 做有界的网站能力与风险侦察');
    expect(prompt).toContain('后续实现仍必须深入探索目标流程');
    expect(prompt).toContain('询问的是 Skill 覆盖范围、边界或必要环境条件');
    expect(prompt).toContain('创建实现工作前，调用 plan(create)');
    expect(prompt).toContain('计划正文首先列出本次准备固化的公开业务工具');
    expect(prompt).toContain('即使用户只提供了网站');
    expect(prompt).toContain('工具名称、一次调用完整完成什么业务能力');
    expect(prompt).toContain('调用后返回什么有用的业务结果');
    expect(prompt).toContain('不提前设计参数 Schema、结构化字段清单或全部页面分支');
    expect(prompt).toContain('直接返回搜索结果');
    expect(prompt).toContain('不能拆成“配置搜索”和“提交搜索”');
    expect(prompt).toContain('覆盖与不覆盖范围');
    expect(prompt).toContain('页面操作步骤只描述工具内部必须走通的路径');
    expect(prompt).toContain('不为凑数增加工具或场景');
    expect(prompt).toContain('独立验证判据');
    expect(prompt).toContain('完整传递已批准验收要求');
    expect(prompt).toContain('不得静默降低验收标准');
    expect(prompt).toContain('browser_skill_status 没有可用构建时');
    expect(prompt).toContain('必须重验直接或间接受影响的公开函数、共享实现和串联路径');
    expect(prompt).toContain('输入输出语义未变化的既有证据可以保留');
    expect(prompt).toContain('修复后按修改影响范围补齐独立验证');
    expect(prompt).not.toContain('源码发生变化或重新 build 后，先前的验证结论不得沿用');
    expect(prompt).not.toContain('必须返回的业务字段');
    expect(prompt).not.toContain('上下游需传递的字段');
    expect(prompt).not.toContain('不预设函数数量、名称');
    expect(prompt).not.toContain('不要亲自探索 selector、拆函数、写源码');
    expect(prompt).not.toMatch(/candidate|hash|revision|pin/);
    expect(prompt).not.toContain('confirm 模式');
    expect(prompt).not.toContain('自动模式');
    expect(prompt).not.toContain('工具调用自动执行');
  });

  it('Browser Skill 不向 AI 暴露 confirm/auto 差异', () => {
    const confirm = assemble(
      browserSkillDirectorIdentity,
      directorCtx({
        modeId: 'browser-skill',
        approvalMode: 'confirm',
      })
    );
    const auto = assemble(
      browserSkillDirectorIdentity,
      directorCtx({
        modeId: 'browser-skill',
        approvalMode: 'auto',
      })
    );

    expect(auto).toBe(confirm);
    expect(auto).toContain('范围确定后先提交验收计划供用户确认');
    expect(auto).not.toMatch(/confirm|auto|确认模式|自动模式/);
  });

  it('normal/plan 不继承 Browser Skill 的构建目标语义', () => {
    const normal = assemble(
      directorIdentity,
      directorCtx({
        modeId: 'normal',
        approvalMode: 'confirm',
      })
    );
    const plan = assemble(
      directorIdentity,
      directorCtx({
        modeId: 'plan',
        approvalMode: 'confirm',
      })
    );

    expect(normal).toContain('直接执行任务，不需要事先制定计划');
    expect(normal).not.toContain('本次要固化的能力范围与验收场景');
    expect(plan).toContain('制定计划提交用户审批');
    expect(plan).not.toContain('本次要固化的能力范围与验收场景');
  });

  it('顶层按任务复杂度决定直接处理或委派', () => {
    const prompt = assemble(
      directorIdentity,
      directorCtx({ modeId: 'normal', approvalMode: 'confirm' })
    );

    expect(prompt).toContain('| 简单任务 | 直接行动并回答 |');
    expect(prompt).toContain('| 读取/查询 | 直接使用原生工具并回答 |');
    expect(prompt).toContain('需要独立执行、专业能力或多步协调的任务');
    expect(prompt).toContain('根据任务所需能力选择合适的 Worker');
    expect(prompt).toContain('委派的 Assignment 由 Worker 独立完成并主动返回结果');
    expect(prompt).toContain('不等待与其无关的 Assignment');
    expect(prompt).toContain('需要等待尚未返回的前置结果才能继续时');
    expect(prompt).toContain('先告知用户当前状态，然后停止操作，等待结果主动返回');
    expect(prompt).toContain('用户询问进度或出现执行异常迹象时，再获取相关状态');
    expect(prompt).toContain('不要与仍在执行的 Assignment 重复工作');
    expect(prompt).toContain('用户发来新要求时，按任务处理方式直接处理或委派');
    expect(prompt).not.toContain('将信息搜集作为前置工作');
    expect(prompt).not.toContain('| 写入/修改/执行 | 创建子流程来完成 |');
    expect(prompt).not.toContain('将新任务纳入全局 Task Board');
    expect(prompt).not.toContain('正确示例：');
  });

  it('L5 标签完整：worker 只含 session_config/file_system，不重复 Assignment', () => {
    const prompt = assemble(workerIdentity, workerCtx());
    expect(prompt).toContain('<session_config>');
    expect(prompt).toContain('<agent_id>worker-1</agent_id>');
    expect(prompt).not.toContain('<main_agent_id>');
    expect(prompt).not.toContain('<browser_id>');
    expect(prompt).not.toContain('<task_id>task-1</task_id>');
    expect(prompt).toContain('<workspace>/ws</workspace>');
    expect(prompt).toContain('<temp_dir>/tmp/t</temp_dir>');
    expect(prompt).not.toContain('<task>\n');
    expect(prompt).not.toContain('<task_board summary=');
    expect(prompt).not.toContain('<assignment>\n');
  });

  it('L5 不向任何 Worker 渲染内部 browser_id', () => {
    const prompt = assemble(workerIdentity, workerCtx({ skills: undefined }));
    expect(prompt).not.toContain('<browser_id>');
  });

  it('worker 渲染自身授权的 MCP deferred 清单', () => {
    const prompt = assemble(
      workerIdentity,
      workerCtx({
        mcpBlock: '- mcp__repo__read_issue: read one issue',
      })
    );
    expect(prompt).toContain('<mcp_tools>');
    expect(prompt).toContain('mcp__repo__read_issue');
  });

  it('director 绑定浏览器环境渲染精确 browserEnvironmentId 与用途，不再强制全覆盖', () => {
    const prompt = assemble(
      directorIdentity,
      directorCtx({
        boundEnvironments: [
          { id: 'p-1', name: '墨西哥店铺', purpose: 'TikTok 店铺运营' },
          { id: 'p-2', name: '备用', purpose: '（未填写用途）' },
        ],
      })
    );

    expect(prompt).toContain('<browser_environments>');
    expect(prompt).toContain(
      '<environment id="p-1" name="墨西哥店铺">TikTok 店铺运营</environment>'
    );
    // 强制全覆盖已废止：绑定池只约束"用池内环境"，不要求每个环境都派发
    expect(prompt).not.toContain('required_coverage');
    expect(prompt).not.toContain('全覆盖');
    expect(prompt).toContain('必须使用清单中的真实 ID');
  });

  it('顶层智能体管理措辞按 canManageAgentRuns 门控', () => {
    const withAgentRun = assemble(
      directorIdentity,
      directorCtx({
        canManageAgentRuns: true,
      })
    );
    expect(withAgentRun).toContain('需要创建或管理其他顶层智能体时，使用对应工具');
    // 用法判据、交接和生命周期由工具 description 在工具可见时提供。
    expect(withAgentRun).not.toContain('flow 编排');
    expect(withAgentRun).not.toContain('免审批白名单');

    // 无 flow 工具的 director 不得收到 flow 身份措辞
    const withoutFlow = assemble(directorIdentity, directorCtx());
    expect(withoutFlow).not.toContain('需要创建或管理其他顶层智能体时，使用对应工具');

    // 模型可见文本统一使用「顶层智能体」，不再使用「顶层 flow」。
    expect(withAgentRun).not.toContain('顶层 flow');
    expect(withoutFlow).not.toContain('顶层 flow');
  });

  it('L5 恒为末层：<context> 块之后无正文', () => {
    const prompt = assemble(workerIdentity, workerCtx());
    expect(prompt.trim().endsWith('</file_system>')).toBe(true);
  });

  it('占位符与旧散布变量绝迹：无 <PARENT_ID>、无「## 会话配置」', () => {
    for (const [identity, ctx] of [
      [directorIdentity, directorCtx({ modeId: 'normal', approvalMode: 'confirm' })],
      [workerIdentity, workerCtx()],
    ] as const) {
      const prompt = assemble(identity, ctx);
      expect(prompt).not.toContain('<PARENT_ID>');
      expect(prompt).not.toContain('## 会话配置');
    }
  });

  it('L1 纪律全员注入：用户沟通 + 数据边界 + 文件系统（保密五条已删）', () => {
    for (const prompt of [
      assemble(directorIdentity, directorCtx()),
      assemble(workerIdentity, workerCtx()),
    ]) {
      expect(prompt).toContain('## 与用户沟通');
      expect(prompt).toContain('首次调用工具前');
      expect(prompt).toContain('关键结果、改变方向或遇到阻塞');
      expect(prompt).not.toContain('用户通常看不到 thinking');
      expect(prompt).toContain('## 数据边界');
      expect(prompt).toContain('## 文件系统');
      expect(prompt).not.toContain('保密规则');
    }
  });

  it('L2 按角色二选一：director 含调度协议，worker 含 completed 契约', () => {
    const director = assemble(directorIdentity, directorCtx());
    expect(director).not.toContain('ENRICH_INFO:');
    expect(director).toContain('<subagent_event');
    expect(director).toContain('Assignment 已完成');
    expect(director).toContain('failed 只表示当前 Assignment 未能完成');
    expect(director).toContain('只有错误明确属于临时问题且重试仍有价值时');
    expect(director).not.toContain('你在一个事件循环中运行');
    expect(director).not.toContain('阶段性汇报');
    expect(director).not.toContain('宽限期');
    expect(director).not.toContain('deadline');
    expect(director).not.toContain('组目录');
    expect(director).not.toContain('同组');
    expect(director).not.toContain('targetId: "group"');
    expect(director).not.toContain('子流程执行流水旁路落盘');
    const worker = assemble(workerIdentity, workerCtx());
    expect(worker).not.toContain('ENRICH_INFO:');
    expect(worker).toContain('send_event');
    expect(worker).toContain('<assignment>');
    expect(worker).toContain('终态 send_event 前先收口任务状态');
    expect(worker).not.toContain('返回空响应');
    expect(worker).toContain('send_event(type: "need_user_action")');
    expect(worker).toContain('用户已完成操作');
    expect(worker).toContain('用户后续明确提出的要求共同定义当前范围');
    expect(worker).toContain('全部要求完成后，调用 send_event(type: "completed")');
    expect(worker).toContain('仍有工作时继续执行');
  });

  it('Browser Skill 专属身份继承通用基座，角色正文不拼接会话值', () => {
    const workerA = workerCtx({
      agentId: 'browser-skill-worker-a',
      flowName: 'flow-a',
    });
    const workerB = workerCtx({
      agentId: 'browser-skill-worker-b',
      flowName: 'flow-b',
    });

    for (const identity of [
      siteScoutIdentity,
      browserSkillBuilderIdentity,
      browserSkillVerifierIdentity,
    ]) {
      const first = identity.render(workerA);
      const second = identity.render(workerB);
      expect(first).toBe(second);
      expect(first).toContain(workerIdentity.render(workerA));
      expect(first).not.toContain('browser-skill-worker-a');
    }

    const director = browserSkillDirectorIdentity.render(directorCtx());
    expect(director).toContain(directorIdentity.render(directorCtx()));
    expect(director).toContain('## Browser Skill 构建编排');
  });

  it('范围侦察与实现提示词分别直接描述本次工作', () => {
    const scout = assemble(siteScoutIdentity, workerCtx());
    const builder = assemble(browserSkillBuilderIdentity, workerCtx());
    const verifier = assemble(browserSkillVerifierIdentity, workerCtx());

    expect(scout).toContain('## 网站能力与范围侦察');
    expect(scout).toContain('主要可见功能区域');
    expect(scout).toContain('可独立固化的业务方向');
    expect(scout).toContain('公共依赖');
    expect(scout).toContain('不得仅将登录列为风险后结束');
    expect(scout).toContain('等待用户在当前浏览器完成');
    expect(scout).toContain('确认阻断解除后继续侦察');
    expect(scout).toContain('登录后区域明确不在 Assignment 边界内时');
    expect(scout).toContain('send_event(type: "need_user_action")');
    expect(scout).not.toContain('不执行登录提交');
    expect(scout).toContain('不为“全面”穷举网站');
    expect(scout).toContain('不要替用户选择多个彼此独立的固化方向');

    expect(builder).toContain('Assignment 中的已批准验收要求');
    expect(builder).toContain('写函数前必须用 browser 深入走通目标流程');
    expect(builder).toContain('不要擅自扩大 Skill');
    expect(verifier).toContain('已批准验收要求是唯一通过标准');
    expect(verifier).toContain('不沿用既有通过结论');
  });

  it('Browser Skill 通用职责不要求自判身份，也不泄漏任务实例或内部版本机制', () => {
    const scout = siteScoutIdentity.render(workerCtx());
    const builder = browserSkillBuilderIdentity.render(workerCtx());
    const verifier = browserSkillVerifierIdentity.render(workerCtx());
    const director = browserSkillDirectorIdentity.render(directorCtx());

    expect(scout).not.toContain('你是 site-scout');
    expect(builder).not.toContain('你是 browser-skill-builder');
    expect(verifier).not.toContain('你是 browser-skill-verifier');
    expect(builder).not.toContain('没有先经过 site-scout');
    expect(verifier).not.toContain('Builder 的通过结论');

    for (const prompt of [scout, builder, verifier, director]) {
      expect(prompt).not.toMatch(/candidate|hash|revision|pin/);
      expect(prompt).not.toMatch(/verifyBlankPassengerRequiredBlock|clickedOnce|携程|ctrip/i);
    }
  });

  it('Builder 完整返回业务字段，Verifier 全量覆盖并生成验收报告', () => {
    const builder = assemble(browserSkillBuilderIdentity, workerCtx());
    const verifier = assemble(browserSkillVerifierIdentity, workerCtx());
    const director = assemble(
      browserSkillDirectorIdentity,
      directorCtx({ modeId: 'browser-skill' })
    );

    expect(builder).toContain('**输出完整性**');
    expect(builder).toContain('具有独立业务意义的字段');
    expect(builder).toContain('业务结果必须是按业务语义命名的结构化对象');
    expect(builder).toContain('列表必须返回字段一致的对象数组');
    expect(builder).toContain('同一列表的每个项保持同一稳定字段结构');
    expect(builder).toContain('不得把页面 HTML、DOM、snapshot、整页文本');
    expect(builder).toContain('必需字段不得为空');
    expect(builder).toContain('业务 ID、详情 URL、selectionKey');
    expect(builder).toContain('data 只可作同源诊断副本');
    expect(builder).toContain('一个工具返回的真实业务结果能用于需要该结果的后续工具');
    expect(builder).toContain('通过页面实际操作到达目标状态');
    expect(builder).toContain('不得拼造搜索、列表、详情或终态 URL');
    expect(builder).toContain('不得用直接跳转替代本函数承诺的');
    expect(builder).toContain('真实差异样例执行 skill_call');
    expect(builder).toContain('单个成功样例不能代表其他分支通过');
    expect(builder).toContain('公开业务工具设计');
    expect(builder).toContain('可独立使用的完整网站业务工具');
    expect(builder).toContain('结果只能供唯一下一步继续使用');
    expect(builder).toContain('直接返回搜索结果');
    expect(builder).toContain('“已填写”“已配置”“可以提交”只属于函数内部状态');
    expect(builder).toContain('click、fill 等原子动作的数量、经过的页面数量');
    expect(builder).toContain('失败恢复和测试方便程度都不决定公开函数边界');
    expect(builder).toContain('不得为了提前 build 或增量测试');
    expect(builder).toContain('少量完整业务工具完成目标');
    expect(builder).not.toContain('可观察的业务 checkpoint');
    expect(builder).not.toContain('可观察、可继续状态');
    expect(builder).not.toContain('返回后续组合需要的结果');
    expect(builder).not.toContain('每新增或修改一个业务函数就立即调用');
    expect(builder).not.toContain('每次调用只点击一次');

    expect(verifier).toContain('全部验收场景列为待验项');
    expect(verifier).toContain('真实差异样例分别独立验证');
    expect(verifier).toContain('不得用它把页面提前放在中间页、结果页或终态');
    expect(verifier).toContain('只能使用页面或上游函数的真实返回，不得编造');
    expect(verifier).toContain('作为两组独立测试');
    expect(verifier).toContain('不能把同一次调用同时计入两组结果');
    expect(verifier).toContain('重复调用函数或重试，不限制调用次数');
    expect(verifier).toContain('不沿用上一测试留下的中间状态');
    expect(verifier).toContain('列表必须是字段一致的对象数组');
    expect(verifier).toContain('以页面 HTML、DOM、snapshot、整页文本');
    expect(verifier).toContain('除已批准边界允许 skipped 的函数外');
    expect(verifier).toContain('每个公开函数至少真实调用一次');
    expect(verifier).toContain('passed / failed / timeout / skipped');
    expect(verifier).toContain('完整验收报告');
    expect(verifier).toContain('分列公开函数逐项测试和串联场景测试');
    expect(verifier).toContain('只有两组测试的全部场景和函数都有结果后才可收尾');
    expect(director).toContain('报告不完整');
    expect(director).toContain('两组分别从真实入口建立状态');
    expect(director).toContain('skipped 未被已批准边界允许时，不得发布');
  });

  it('Builder 将 snapshot 限定为构建观察，并按同状态 DOM 证据验证固化稳定性', () => {
    const builder = assemble(browserSkillBuilderIdentity, workerCtx());

    expect(builder).toContain('browser snapshot 只用于构建期观察当前页面');
    expect(builder).toContain('UID、节点层级和 StaticText 等可访问性节点类型不构成固化 locator');
    expect(builder).toContain('在当前 DOM 中确认实际 Element');
    expect(builder).toContain('每次调用重新解析的标准 HTML/ARIA 语义');
    expect(builder).toContain('操作前确认目标唯一、可见且实际命中');
    expect(builder).toContain('从同一入口重建相同业务状态');
    expect(builder).toContain('核对两者命中的实际 DOM Element、操作前状态和操作后的业务结果');
    expect(builder).toContain('不把不同页面状态的结果或 snapshot 节点类型作为根因证据');
    expect(builder).toContain('必须交错建立不同页面状态验证');
    expect(builder).toContain('错误命中、意外导航、依赖隐藏元素');
    expect(builder).toContain('检查同一 Skill 中使用相同实现的全部位置');
    expect(builder).toContain('必须使用与当前页面真实值不同的输入触发操作');
    expect(builder).toContain('重新导航到同一入口不能证明网站已清除持久化状态');
    expect(builder).toContain('浏览器动作或读取失败不得被吞成 notDisplayed、空结果');
    expect(builder).toContain('只有页面事实确认目标不存在时');
    expect(builder).toContain('使用相同输入再次调用有合理成功机会时才为 true');
    expect(builder).toContain('输入错误、业务拒绝和实现不变量失败');
    expect(builder).toContain('所有直接或间接受影响的路径必须基于最新构建重新实测');
    expect(builder).toContain('未经过受改代码且输入输出语义未变化的既有验证可以保留');
    expect(builder).toContain('已有成功只有在确实执行过待验证分支时才构成证据');
    expect(builder).toContain('导致关键操作被跳过的调用，不能证明该操作分支有效');
    expect(builder).toContain('Locators are resolved from the current DOM for every operation');
    expect(builder).toContain('browser accessibility snapshot roles such as `StaticText`');
    expect(builder).toContain('Actions require an actionable DOM target');
    expect(builder).toContain('回报 platform capability gap');
    expect(builder).toContain('report a platform capability gap');
  });

  it('Builder 独占 Authoring Guide 与同源 SDK Reference，其他角色和 normal/plan 不泄漏', () => {
    const builder = assemble(browserSkillBuilderIdentity, workerCtx());
    const promptsWithoutAuthorDocs = [
      assemble(workerIdentity, workerCtx()),
      assemble(siteScoutIdentity, workerCtx()),
      assemble(browserSkillVerifierIdentity, workerCtx()),
      assemble(directorIdentity, directorCtx({ modeId: 'normal', approvalMode: 'confirm' })),
      assemble(directorIdentity, directorCtx({ modeId: 'plan', approvalMode: 'confirm' })),
      assemble(browserSkillDirectorIdentity, directorCtx()),
    ];

    expect(occurrences(builder, '## Browser Skill 构建原则')).toBe(1);
    expect(occurrences(builder, '## Browser Skill SDK API Reference')).toBe(1);
    expect(builder).toContain('type: browser');
    expect(builder).toContain('目录名、frontmatter name 和 skill.ts 的 defineSkill name');
    expect(builder).toContain('它写网站业务编排，不写浏览器驱动');
    expect(builder).toContain('在当前 DOM 中确认实际 Element');
    expect(builder).toContain('当次 UID 点击成功不等于已经固化成功');
    expect(builder).toContain('platform capability gap');
    expect(builder).toContain(
      "import { defineSkill, fail, ok, z, type BrowserSkillRuntime } from 'piskiepilot/core-skill'"
    );
    expect(builder).toContain('extractList');
    expect(builder).toContain('doubleClick');
    expect(builder).toContain('Use `hover` when moving the pointer');
    for (const prompt of promptsWithoutAuthorDocs) {
      expect(occurrences(prompt, '## Browser Skill 构建原则')).toBe(0);
      expect(occurrences(prompt, '## Browser Skill SDK API Reference')).toBe(0);
      expect(prompt).not.toContain('它写网站业务编排，不写浏览器驱动');
      expect(prompt).not.toContain('当次 UID 点击成功不等于已经固化成功');
    }
  });

  it('Browser Skill 各角色完整 prompt 保持有界，并记录首次字符基线', () => {
    const prompts = {
      normalDirector: assemble(
        directorIdentity,
        directorCtx({ modeId: 'normal', approvalMode: 'confirm' })
      ),
      planDirector: assemble(
        directorIdentity,
        directorCtx({ modeId: 'plan', approvalMode: 'confirm' })
      ),
      browserSkillDirector: assemble(
        browserSkillDirectorIdentity,
        directorCtx({
          modeId: 'browser-skill',
          approvalMode: 'confirm',
        })
      ),
      ordinaryWorker: assemble(workerIdentity, workerCtx()),
      siteScout: assemble(siteScoutIdentity, workerCtx()),
      browserSkillBuilder: assemble(browserSkillBuilderIdentity, workerCtx()),
      browserSkillVerifier: assemble(browserSkillVerifierIdentity, workerCtx()),
    };
    const lengths = Object.fromEntries(
      Object.entries(prompts).map(([name, prompt]) => [name, prompt.length])
    );

    // These broad ceilings catch accidental document duplication while allowing
    // deliberate edits to the shared prompt foundation without snapshot churn.
    expect(lengths.normalDirector).toBeLessThan(20_000);
    expect(lengths.planDirector).toBeLessThan(20_000);
    expect(lengths.browserSkillDirector).toBeLessThan(24_000);
    expect(lengths.ordinaryWorker).toBeLessThan(16_000);
    expect(lengths.siteScout).toBeLessThan(18_000);
    expect(lengths.browserSkillBuilder).toBeLessThan(36_000);
    expect(lengths.browserSkillVerifier).toBeLessThan(18_000);
    expect(lengths.browserSkillBuilder).toBeGreaterThan(lengths.ordinaryWorker);
  });

  it('Builder 作者文档为空时在 prompt 组装前明确失败', () => {
    expect(() => renderBrowserSkillAuthoringGuide('')).toThrow(
      'Browser Skill Authoring Guide is unavailable'
    );
    expect(() => renderBrowserSkillSdkReference('   ')).toThrow(
      'Browser Skill SDK API Reference is unavailable'
    );
  });

  it('裁剪后的 Scout/Verifier 不注入与实际工具投影冲突的完整 browser 教学', () => {
    const skillDocs = '# Browser\n\n优先用 UID 点击、填写或悬停。';
    const scout = assemble(siteScoutIdentity, workerCtx({ skillDocs }));
    const verifier = assemble(browserSkillVerifierIdentity, workerCtx({ skillDocs }));
    const builder = assemble(browserSkillBuilderIdentity, workerCtx({ skillDocs }));

    expect(scout).not.toContain('优先用 UID 点击');
    expect(verifier).not.toContain('优先用 UID 点击');
    expect(builder).toContain('优先用 UID 点击');
  });

  it('Browser Skill Worker 仍只通过标准 L5 接收会话值，不出现专用 Assignment 字段', () => {
    for (const identity of [
      siteScoutIdentity,
      browserSkillBuilderIdentity,
      browserSkillVerifierIdentity,
    ]) {
      const prompt = assemble(
        identity,
        workerCtx({
          agentId: 'browser-skill-worker',
          flowName: 'browser-skill-flow-secret',
        })
      );
      expect(prompt).toContain('<agent_id>browser-skill-worker</agent_id>');
      expect(prompt).not.toContain('<main_agent_id>');
      expect(prompt).not.toContain('<browser_id>');
      expect(prompt).not.toContain('browser-skill-flow-secret');
      expect(prompt).not.toContain('browserSkillAssignment');
    }
  });

  it('<user_instructions> 槽位：有值渲染在 L2 之后 L3 之前，无值不渲染', () => {
    const withInstructions = assemble(
      directorIdentity,
      directorCtx({
        modeId: 'normal',
        approvalMode: 'confirm',
        userInstructions: '回复一律使用粤语。',
      })
    );
    expect(withInstructions).toContain(
      '<user_instructions>\n回复一律使用粤语。\n</user_instructions>'
    );
    expect(withInstructions.indexOf('<user_instructions>')).toBeLessThan(
      withInstructions.indexOf('## 执行模式')
    );
    const without = assemble(directorIdentity, directorCtx());
    expect(without).not.toContain('<user_instructions>');
  });

  it('L4 由 identity 声明注入：director 含技能文档段', () => {
    const prompt = assemble(directorIdentity, directorCtx());
    expect(prompt).toContain('## 技能与工具文档');
    expect(prompt).toContain('（测试技能文档）');
  });

  it('L5 XML 转义：变量值中的特殊字符被转义', () => {
    const prompt = assemble(workerIdentity, workerCtx({ agentId: 'worker<a&b' }));
    expect(prompt).toContain('<agent_id>worker&lt;a&amp;b</agent_id>');
  });

  it('<available_skills> 仅非 worker 且有块文本时渲染（块内容原样注入）', () => {
    const block = [
      '- example-shop: 示例站点自动化 (file: /skills/example-shop/SKILL.md) [functions: detectState,searchProduct]',
      '- pdf-notes: PDF 处理知识技能 (file: /skills/pdf-notes/SKILL.md)',
      '',
      '- 若用户点名某技能，或当前任务明确匹配上面某条 description，本轮必须使用该技能：',
    ].join('\n');
    const director = assemble(directorIdentity, directorCtx({ availableSkillsBlock: block }));
    expect(director).toContain('<available_skills>');
    expect(director).toContain(
      '- example-shop: 示例站点自动化 (file: /skills/example-shop/SKILL.md) [functions: detectState,searchProduct]'
    );
    expect(director).toContain('本轮必须使用该技能');

    // L0 静态指引会提到 `<available_skills>` 字面量，故用闭合标签断言 L5 块不渲染
    const empty = assemble(directorIdentity, directorCtx({ availableSkillsBlock: undefined }));
    expect(empty).not.toContain('</available_skills>');
    // worker 恒不渲染（即使 ctx 误带清单）
    const worker = assemble(workerIdentity, workerCtx({ availableSkillsBlock: block }));
    expect(worker).not.toContain('</available_skills>');
  });
});
