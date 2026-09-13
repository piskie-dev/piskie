/**
 * SendEventTool 投递守门测试：
 * terminalReason 仅在事件实际送达（delivered === true）时产生；
 * 投递失败以工具错误回给 AI，不结束冲程。
 */

import { describe, expect, it, vi } from 'vitest';
import type { SubagentNotification } from '../../../../shared/types/index.js';
import type { ToolContext } from '../../types.js';
import { parse, toApiSchema } from '../../params.js';
import { ToolCatalog } from '../../catalog.js';
import { SendEventTool } from '../send-event.tool.js';

async function sendToParent(
  type: SubagentNotification['type'],
  onNotification: () => boolean,
) {
  const declareTerminal = vi.fn();
  const context = {
    agentId: 'worker-1',
    agentType: 'worker',
    events: {
      allowedTargets: () => ['director-1'],
      send: () => false,
      notifyParent: onNotification,
    },
    declareTerminal,
  } as unknown as ToolContext;
  return {
    output: await new SendEventTool().execute({ type, message: '正文' }, context),
    declareTerminal,
  };
}

function sendToSubagent(
  sendEventToSubagent: (id: string, message: string) => boolean,
) {
  const context = {
    agentId: 'director-1',
    agentType: 'main',
    events: {
      allowedTargets: () => ['worker-1'],
      send: sendEventToSubagent,
      notifyParent: () => false,
    },
  } as unknown as ToolContext;
  return new SendEventTool().execute(
    { type: 'message', message: '正文', targetId: 'worker-1' },
    context,
  );
}

describe('send_event ToolDefinition', () => {
  it('运行时 Schema 要求显式 type，并接受完整事件集合', () => {
    const tool = new SendEventTool();
    const schema = toApiSchema(tool.def.schema);
    const typeSchema = schema.properties.type as { enum: string[] };

    expect(typeSchema.enum).toEqual([
      'message',
      'completed',
      'failed',
      'user_stopped',
      'need_user_action',
    ]);
    expect(schema.required).toEqual(['type', 'message']);
    expect(parse(tool.def.schema, { message: '缺少类型' }).ok).toBe(false);
  });

  it('Director 只看见定向 message 契约，Worker 看不见 targetId', () => {
    const catalog = new ToolCatalog();
    catalog.register(new SendEventTool(), 'builtin');
    const definition = (agentType: 'main' | 'worker') => catalog.snapshot({
      scope: agentType === 'main' ? 'main' : 'subagent',
      agentType,
      customTools: ['send_event'],
      exposedSkillFunctions: [],
      excluded: new Set(),
      domains: new Set(['local']),
    }).definitions().find((candidate) => candidate.name === 'send_event');

    const director = definition('main');
    expect(Object.keys(director?.input_schema.properties ?? {})).toEqual([
      'type', 'targetId', 'message', 'summary',
    ]);
    expect(director?.input_schema.properties.type).toMatchObject({ const: 'message' });
    expect(director?.input_schema.required).toEqual(['type', 'targetId', 'message']);
    expect(director?.input_schema.properties.message).toMatchObject({
      description: 'Worker 继续工作所需的新事实或要求。涉及新增或变更任务时，明确交付要求及原任务如何处理。',
    });
    expect(director?.description).not.toContain('completed：');

    const worker = definition('worker');
    expect(Object.keys(worker?.input_schema.properties ?? {})).toEqual([
      'type', 'message', 'summary',
    ]);
    expect(worker?.input_schema.properties).not.toHaveProperty('targetId');
    expect(worker?.input_schema.properties.type).toMatchObject({
      enum: ['message', 'completed', 'failed', 'user_stopped', 'need_user_action'],
    });
    expect(worker?.input_schema.required).toEqual(['type', 'message']);
    const workerReportGuidance = '普通进展，以及能够自行处理的新发现和问题，不发送 message，完成后随完整结果一并汇报。只有需要 Director 解除无法自行解决的阻碍或协调工作冲突时，才发送 message，写清问题和需要它采取的行动。';
    expect(worker?.description).toContain(workerReportGuidance);
    expect(director?.description).not.toContain(workerReportGuidance);
    expect(worker?.description).toContain(
      '之后收到新的用户要求或 Director 消息时，继续按新要求处理',
    );
    expect(worker?.description).not.toContain('三次重试');
  });
});

describe('send_event 投递守门', () => {
  it('终态送达（delivered=true）：返回 terminalReason，runTurn 据此 yield', async () => {
    const { output, declareTerminal } = await sendToParent('completed', () => true);
    expect(output.ok).toBe(true);
    expect(declareTerminal).toHaveBeenCalledWith('completed');
  });

  it('终态未送达（delivered=false）：工具错误且无 terminalReason，冲程不结束', async () => {
    const { output, declareTerminal } = await sendToParent('completed', () => false);
    expect(output.ok).toBe(false);
    expect(declareTerminal).not.toHaveBeenCalled();
    expect(output.text).toContain('未送达');
  });

  it('三种终态在送达时对称产生 terminalReason', async () => {
    for (const type of ['completed', 'failed', 'user_stopped'] as const) {
      const { output, declareTerminal } = await sendToParent(type, () => true);
      expect(output.ok).toBe(true);
      expect(declareTerminal).toHaveBeenCalledWith(type);
    }
  });

  it('need_user_action 送达：普通成功，不产生 terminalReason', async () => {
    const { output, declareTerminal } = await sendToParent('need_user_action', () => true);
    expect(output.ok).toBe(true);
    expect(declareTerminal).not.toHaveBeenCalled();
    expect(output.text).toContain('当前执行将挂起');
  });
});

describe('send_event 父→子投递守门', () => {
  it('送达（post 返回 true）：普通成功', async () => {
    const res = await sendToSubagent(() => true);
    expect(res.ok).toBe(true);
  });

  it('未送达（post 返回 false）：工具错误，不假装已发送', async () => {
    const res = await sendToSubagent(() => false);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('未送达');
  });
});

describe('send_event full message delivery', () => {
  it.each([undefined, 'Sample preview.'])('delivers the complete long parent message with summary %s', async (summary) => {
    const message = 'Sample instruction.\n'.repeat(100) + 'Final requirement.';
    const send = vi.fn(() => true);
    const context = {
      agentId: 'main-1',
      mainAgentId: 'main-1',
      agentType: 'main',
      events: {
        allowedTargets: () => ['worker-1'],
        send,
        notifyParent: () => false,
      },
    } as unknown as ToolContext;

    const output = await new SendEventTool().execute(
      { type: 'message', message, summary, targetId: 'worker-1' },
      context,
    );

    expect(message.length).toBeGreaterThan(1000);
    expect(output.ok).toBe(true);
    expect(send).toHaveBeenCalledWith('worker-1', message);
  });

  it.each([
    ['message', 'message'],
    ['completed', 'message'],
    ['failed', 'error'],
    ['user_stopped', 'reason'],
    ['need_user_action', 'message'],
  ] as const)('delivers the complete long %s notification in its %s field', async (type, field) => {
    const message = 'Sample result.\n'.repeat(100) + 'Final finding.';
    const notifyParent = vi.fn(() => true);
    const declareTerminal = vi.fn();
    const context = {
      agentId: 'worker-1',
      mainAgentId: 'main-1',
      agentType: 'worker',
      events: {
        allowedTargets: () => ['main-1'],
        send: () => false,
        notifyParent,
      },
      declareTerminal,
    } as unknown as ToolContext;

    const output = await new SendEventTool().execute(
      { type, message, summary: 'Sample preview.' },
      context,
    );

    expect(message.length).toBeGreaterThan(1000);
    expect(output.ok).toBe(true);
    expect(notifyParent).toHaveBeenCalledWith({ type, [field]: message });
    if (type === 'completed' || type === 'failed' || type === 'user_stopped') {
      expect(declareTerminal).toHaveBeenCalledWith(type);
    } else {
      expect(declareTerminal).not.toHaveBeenCalled();
    }
  });

  it('Runtime 拒绝 Director 发送控制事件', async () => {
    const send = vi.fn(() => true);
    const context = {
      agentId: 'main-1',
      mainAgentId: 'main-1',
      agentType: 'main',
      events: {
        allowedTargets: () => ['worker-1'],
        send,
        notifyParent: () => false,
      },
    } as unknown as ToolContext;

    const output = await new SendEventTool().execute(
      { type: 'completed', message: '不应发送', targetId: 'worker-1' },
      context,
    );

    expect(output.ok).toBe(false);
    expect(output.text).toContain('Director 只能发送');
    expect(send).not.toHaveBeenCalled();
  });

  it('Runtime 拒绝 Worker 自行指定 targetId', async () => {
    const notifyParent = vi.fn(() => true);
    const context = {
      agentId: 'worker-1',
      mainAgentId: 'main-1',
      agentType: 'worker',
      events: {
        allowedTargets: () => ['main-1'],
        send: () => false,
        notifyParent,
      },
    } as unknown as ToolContext;

    const output = await new SendEventTool().execute(
      { type: 'message', message: '不应发送', targetId: 'main-1' },
      context,
    );

    expect(output.ok).toBe(false);
    expect(output.text).toContain('不能指定 targetId');
    expect(notifyParent).not.toHaveBeenCalled();
  });
});
