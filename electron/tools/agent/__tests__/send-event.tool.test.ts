/**
 * SendEventTool 投递守门测试：
 * terminalReason 仅在事件实际送达（delivered === true）时产生；
 * 投递失败以工具错误回给 AI，不结束冲程。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ATAEventEnvelope } from '../../../agent/ata/ata-event-envelope.js';
import { ataEventPayloadStore } from '../../../agent/ata/ata-event-payload-store.js';
import type { ToolContext, ToolOutput } from '../../types.js';
import { parse, toApiSchema } from '../../params.js';
import { ToolCatalog } from '../../catalog.js';
import { SendEventTool } from '../send-event.tool.js';

afterEach(() => {
  vi.restoreAllMocks();
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

type SendMethod = (
  targetId: string,
  envelope: ATAEventEnvelope,
  context: ToolContext,
) => ToolOutput<unknown>;

function sendToParent(
  envelopeType: ATAEventEnvelope['type'],
  onNotification: () => boolean,
): { output: ToolOutput<unknown>; declareTerminal: ReturnType<typeof vi.fn> } {
  const tool = new SendEventTool();
  const envelope = {
    storage: 'inline',
    type: envelopeType,
    data: { type: envelopeType, message: '正文' },
    originalSize: 2,
  } satisfies ATAEventEnvelope;
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
    output: (tool as unknown as { sendToParent: SendMethod }).sendToParent(
      'director-1',
      envelope,
      context,
    ),
    declareTerminal,
  };
}

function sendToSubagent(
  sendEventToSubagent: (id: string, event: Record<string, unknown>) => boolean,
): ToolOutput<unknown> {
  const tool = new SendEventTool();
  const envelope = {
    storage: 'inline',
    type: 'message',
    data: { type: 'message', message: '正文' },
    originalSize: 2,
  } satisfies ATAEventEnvelope;
  const context = {
    agentId: 'director-1',
    agentType: 'main',
    events: {
      allowedTargets: () => ['worker-1'],
      send: sendEventToSubagent,
      notifyParent: () => false,
    },
  } as unknown as ToolContext;
  return (tool as unknown as { sendToSubagent: SendMethod }).sendToSubagent(
    'worker-1',
    envelope,
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
    expect(director?.description).toContain('变化后的目标、范围、约束');
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
    expect(worker?.description).toContain(
      '之后收到新的用户要求或 Director 消息时，继续按新要求处理',
    );
    expect(worker?.description).not.toContain('三次重试');
  });
});

describe('send_event 投递守门', () => {
  it('终态送达（delivered=true）：返回 terminalReason，runTurn 据此 yield', () => {
    const { output, declareTerminal } = sendToParent('completed', () => true);
    expect(output.ok).toBe(true);
    expect(declareTerminal).toHaveBeenCalledWith('completed');
  });

  it('终态未送达（delivered=false）：工具错误且无 terminalReason，冲程不结束', () => {
    const { output, declareTerminal } = sendToParent('completed', () => false);
    expect(output.ok).toBe(false);
    expect(declareTerminal).not.toHaveBeenCalled();
    expect(output.text).toContain('未送达');
  });

  it('三种终态在送达时对称产生 terminalReason', () => {
    for (const type of ['completed', 'failed', 'user_stopped'] as const) {
      const { output, declareTerminal } = sendToParent(type, () => true);
      expect(output.ok).toBe(true);
      expect(declareTerminal).toHaveBeenCalledWith(type);
    }
  });

  it('need_user_action 送达：普通成功，不产生 terminalReason', () => {
    const { output, declareTerminal } = sendToParent('need_user_action', () => true);
    expect(output.ok).toBe(true);
    expect(declareTerminal).not.toHaveBeenCalled();
    expect(output.text).toContain('当前执行将挂起');
  });
});

describe('send_event 父→子投递守门', () => {
  it('送达（post 返回 true）：普通成功', () => {
    const res = sendToSubagent(() => true);
    expect(res.ok).toBe(true);
  });

  it('未送达（post 返回 false）：工具错误，不假装已发送', () => {
    const res = sendToSubagent(() => false);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('未送达');
  });
});

describe('send_event ATA event execute boundary', () => {
  it('Main 构造顶层 source，并把当前 ATAEventEnvelope 投递给 Worker', async () => {
    const envelope = {
      storage: 'inline',
      type: 'message',
      data: { type: 'message', message: '继续执行' },
      originalSize: 4,
    } satisfies ATAEventEnvelope;
    const prepareEnvelope = vi.spyOn(ataEventPayloadStore, 'prepareEnvelope')
      .mockResolvedValue(envelope);
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
      { type: 'message', message: '继续执行', targetId: 'worker-1' },
      context,
    );

    expect(output.ok).toBe(true);
    expect(prepareEnvelope).toHaveBeenCalledWith(
      { agentId: 'main-1' },
      { type: 'message', message: '继续执行' },
    );
    expect(send).toHaveBeenCalledWith('worker-1', envelope);
  });

  it('Worker 构造 owner-local source，并经当前 ATAEventEnvelope 通知 Main', async () => {
    const envelope = {
      storage: 'inline',
      type: 'completed',
      data: { type: 'completed', message: '任务完成' },
      originalSize: 4,
    } satisfies ATAEventEnvelope;
    const prepareEnvelope = vi.spyOn(ataEventPayloadStore, 'prepareEnvelope')
      .mockResolvedValue(envelope);
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
      { type: 'completed', message: '任务完成' },
      context,
    );

    expect(output.ok).toBe(true);
    expect(prepareEnvelope).toHaveBeenCalledWith(
      { agentId: 'main-1', workerId: 'worker-1' },
      { type: 'completed', message: '任务完成' },
    );
    expect(notifyParent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'completed',
      message: '任务完成',
      data: envelope,
    }));
    expect(declareTerminal).toHaveBeenCalledWith('completed');
  });

  it('Runtime 拒绝 Director 发送控制事件', async () => {
    const prepareEnvelope = vi.spyOn(ataEventPayloadStore, 'prepareEnvelope');
    const context = {
      agentId: 'main-1',
      mainAgentId: 'main-1',
      agentType: 'main',
      events: {
        allowedTargets: () => ['worker-1'],
        send: () => true,
        notifyParent: () => false,
      },
    } as unknown as ToolContext;

    const output = await new SendEventTool().execute(
      { type: 'completed', message: '不应发送', targetId: 'worker-1' },
      context,
    );

    expect(output.ok).toBe(false);
    expect(output.text).toContain('Director 只能发送');
    expect(prepareEnvelope).not.toHaveBeenCalled();
  });

  it('Runtime 拒绝 Worker 自行指定 targetId', async () => {
    const prepareEnvelope = vi.spyOn(ataEventPayloadStore, 'prepareEnvelope');
    const context = {
      agentId: 'worker-1',
      mainAgentId: 'main-1',
      agentType: 'worker',
      events: {
        allowedTargets: () => ['main-1'],
        send: () => false,
        notifyParent: () => true,
      },
    } as unknown as ToolContext;

    const output = await new SendEventTool().execute(
      { type: 'message', message: '不应发送', targetId: 'main-1' },
      context,
    );

    expect(output.ok).toBe(false);
    expect(output.text).toContain('不能指定 targetId');
    expect(prepareEnvelope).not.toHaveBeenCalled();
  });
});
