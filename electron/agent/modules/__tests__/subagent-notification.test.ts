import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/piskie-test',
    getAppPath: () => '/tmp/piskie-test',
  },
}));

import { AIErrorType } from '../../../../shared/constants/index.js';
import type { AgentHost } from '../../agent-host.js';
import { SubagentModule } from '../subagent.module.js';
import { normalizeSubagentNotification } from '../../ata/ata-event-protocol.js';

function createHarness(interrupted = false) {
  const module = new SubagentModule() as SubagentModule & {
    host: AgentHost;
    getTraceRecorder: () => undefined;
  };
  const addUserMessage = vi.fn();
  const post = vi.fn((event) => module.processEvent(event));
  const emitStateChange = vi.fn();
  module.host = {
    id: 'main-1',
    mainAgentId: 'main-1',
    interrupted,
    post,
    addUserMessage,
    emitStateChange,
  } as unknown as AgentHost;
  module.getTraceRecorder = () => undefined;
  return { module, addUserMessage, post };
}

function envelopeBody(envelope: string): string {
  return envelope.replace(/^<subagent_event[^>]*>\n/, '').replace(/\n<\/subagent_event>$/, '');
}

describe('subagent notification normalization', () => {
  it.each([
    [{ type: 'message', message: '普通消息' }, '普通消息'],
    [{ type: 'completed', message: '完成' }, '完成'],
    [{ type: 'failed', error: '失败原文' }, '失败原文'],
    [{ type: 'user_stopped', reason: '用户停止' }, '用户停止'],
    [{ type: 'need_user_action', message: '请登录' }, '请登录'],
  ] as const)('projects every public notification shape to one text field', (input, text) => {
    expect(normalizeSubagentNotification(input)).toMatchObject({ type: input.type, text });
  });

  it('用户中断 Worker 只注入该 Worker 的增量状态', async () => {
    const { module, post } = createHarness();
    const child = {
      interrupted: false,
      instantInterrupt: vi.fn(async () => {
        child.interrupted = true;
      }),
    };
    (module as unknown as { subagents: Map<string, typeof child> }).subagents.set(
      'worker-a',
      child
    );

    await expect(module.interruptChildImmediately('worker-a')).resolves.toBe(true);

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({
      source: 'system',
      content:
        '<worker_interrupted>\n' +
        'worker-a 被用户中断，原 ID 仍有效；不要继续等待，仅在后续用户目标需要时向其发送消息。\n' +
        '</worker_interrupted>',
    });
  });

  it('Main 已中断时不即时投递，恢复事件从全部已中断 Worker 派生', async () => {
    const { module, post } = createHarness(true);
    const workerA = {
      interrupted: false,
      instantInterrupt: vi.fn(async () => {
        workerA.interrupted = true;
      }),
    };
    const workerB = {
      interrupted: true,
      instantInterrupt: vi.fn(async () => undefined),
    };
    const subagents = (module as unknown as {
      subagents: Map<string, typeof workerA | typeof workerB>;
    }).subagents;
    subagents.set('worker-a', workerA);
    subagents.set('worker-b', workerB);

    await expect(module.interruptChildImmediately('worker-a')).resolves.toBe(true);

    expect(post).not.toHaveBeenCalled();
    expect(module.buildUserInterruptedWorkersEvent()).toEqual({
      source: 'system',
      content:
        '<worker_interrupted>\n' +
        '- worker-a 被用户中断，原 ID 仍有效；不要继续等待，仅在后续用户目标需要时向其发送消息。\n' +
        '- worker-b 被用户中断，原 ID 仍有效；不要继续等待，仅在后续用户目标需要时向其发送消息。\n' +
        '</worker_interrupted>',
    });
  });

  it('keeps a runtime provider failure verbatim and projects structured diagnostics', () => {
    const { module, addUserMessage } = createHarness();
    const providerMessage = 'Your input exceeds the context window of this model.\n'
      + 'Please adjust your input and try again.';

    const delivered = module.createSubagentNotificationHandler('child-1')({
      type: 'failed',
      error: providerMessage,
      data: { origin: 'runtime' },
      failure: {
        errorType: AIErrorType.CONTEXT_OVERFLOW,
        diagnostics: {
          providerId: 'relay',
          modelId: 'test-model',
          traceId: 'trace-1',
          upstream: { requestId: 'request-1' },
        },
      },
    });

    expect(delivered).toBe(true);
    const envelope = addUserMessage.mock.calls[0]?.[0]?.text as string;
    expect(envelope).toContain('type="failed"');
    expect(envelope).toContain('error_type="context_overflow"');
    expect(envelope).toContain('provider="relay"');
    expect(envelope).toContain('model="test-model"');
    expect(envelope).toContain('request_id="request-1"');
    expect(envelopeBody(envelope)).toBe(providerMessage);
  });

  it('routes model send_event failed through the same canonical envelope', () => {
    const { module, addUserMessage } = createHarness();
    module.createSubagentNotificationHandler('child-2')({
      type: 'failed',
      error: '模型报告失败',
      data: {
        storage: 'inline',
        type: 'failed',
        data: { type: 'failed', message: '模型报告失败' },
        originalSize: 6,
      },
    });

    const envelope = addUserMessage.mock.calls[0]?.[0]?.text as string;
    expect(envelope).toContain('type="failed"');
    expect(envelopeBody(envelope)).toBe('模型报告失败');
  });
});
