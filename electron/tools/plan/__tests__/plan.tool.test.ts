import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../agent-runs/plan-repository.js', () => ({
  planRepository: {
    createPlan: vi.fn(async () => ({
      planId: 'approved-plan',
      documentPath: '/tmp/approved-plan.md',
    })),
    readCurrentPlan: vi.fn(async () => null),
  },
}));



import { planRepository } from '../../../agent-runs/plan-repository.js';
import type { ToolContext } from '../../types.js';
import { PlanTool } from '../plan.tool.js';

function context(mode: string) {
  const modeId = vi.fn(() => mode);
  const exitPlan = vi.fn();
  const setCurrentPlanId = vi.fn();
  return {
    agentId: 'main-1',
    mainAgentId: 'main-1',
    modes: { modeId, approvalMode: () => 'auto' },
    plan: { exitPlan, setCurrentPlanId },
    modeId,
    exitPlan,
    setCurrentPlanId,
  } as unknown as ToolContext & {
    modeId: ReturnType<typeof vi.fn>;
    exitPlan: ReturnType<typeof vi.fn>;
    setCurrentPlanId: ReturnType<typeof vi.fn>;
  };
}

describe('PlanTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['normal', 'plan', 'browser-skill'])(
    '%s 模式下 create 均直接创建计划，不读取当前模式',
    async (mode) => {
      const tool = new PlanTool();
      const ctx = context(mode);

      const result = await tool.execute({
        action: 'create',
        taskSummary: '站点 Skill 验收',
        planDocument: '## 目标\n创建并验证 Skill。',
      }, ctx);

      expect(result).toMatchObject({
        ok: true,
        data: {
          planId: 'approved-plan',
          taskSummary: '站点 Skill 验收',
          documentPath: '/tmp/approved-plan.md',
        },
      });
      expect(ctx.modeId).not.toHaveBeenCalled();
      expect(planRepository.createPlan).toHaveBeenCalledWith(
        'main-1',
        '站点 Skill 验收',
        '## 目标\n创建并验证 Skill。',
      );
      expect(ctx.setCurrentPlanId).toHaveBeenCalledWith('approved-plan');
      expect(ctx.exitPlan).toHaveBeenCalledOnce();
    },
  );

  it('工具说明不暴露模式限制或恢复机制', () => {
    const description = new PlanTool().def.description;
    expect(description).not.toContain('仅计划模式');
    expect(description).not.toContain('切回');
    expect(description).not.toContain('恢复模式');
    expect(description).toContain('只提前确定会影响范围、实现方向或安全边界的关键决策');
    expect(description).toContain('实现细节在执行时根据事实判断');
    expect(description).toContain('重新提交一份完整计划');
    expect(description).not.toContain('无需再做任何决策');
    expect(description).not.toContain('readFile');
    expect(description).not.toContain('三个网站');
  });

  it('获批结果要求建立 Task Board 并立即执行', async () => {
    const result = await new PlanTool().execute({
      action: 'create',
      taskSummary: '通用计划',
      planDocument: '## 目标与范围\n完成目标。',
    }, context('plan'));

    expect(result.ok).toBe(true);
    expect(result.text).toContain('正文位于 /tmp/approved-plan.md');
    expect(result.text).toContain('建立 Task Board 并开始执行');
    expect(result.text).not.toContain('细粒度');
  });
});
