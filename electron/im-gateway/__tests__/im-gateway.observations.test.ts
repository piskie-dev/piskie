import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const os = await import('node:os');
  return {
    app: { getPath: () => os.tmpdir() },
    powerSaveBlocker: { start: () => 1, stop: () => undefined },
  };
});



vi.mock('../../core/storage/index.js', () => ({
  taskDefinitionStore: { get: () => null },
}));

vi.mock('../channels/index.js', () => ({
  registerBuiltinChannels: () => undefined,
  BUILTIN_CHANNEL_INFOS: [],
}));

import { createAgentObservations } from '../../agent/observations.js';
import type { AgentService } from '../../services/agent.service.js';
import { IMGateway } from '../index.js';
import { ReplyInterceptor } from '../reply-interceptor.js';
import { createDeliveryQueue } from '../core/outbound.js';
import type { ConversationEntry, ToolEntry } from '../../../shared/types/agent-control.js';

function fakeAgentService(entries: ConversationEntry[] = []) {
  return {
    hasAgentInMemory: vi.fn((agentId: string) => agentId === 'main-1'),
    getConversationStore: () => ({ read: () => entries }),
  } as unknown as AgentService;
}

function interceptorOf(gateway: IMGateway) {
  return (gateway as unknown as {
    replyInterceptor: ReplyInterceptor;
  }).replyInterceptor;
}

describe('IMGateway Agent observation binding', () => {
  it('sends existing read references and partially committed generated images without a renderer', async () => {
    const gateway = new IMGateway();
    const observations = createAgentObservations();
    const deliver = vi.fn(async () => {});
    const queue = createDeliveryQueue({ deliver });
    const entries: ConversationEntry[] = [{
      t: 'msg', id: 'message-1', ts: 1, role: 'assistant', content: [
        { type: 'tool_use', id: 'read-1', name: 'read', input: {} },
        { type: 'tool_use', id: 'generate-1', name: 'generate_image', input: {} },
      ],
    }];
    gateway.injectDependencies({ agentService: fakeAgentService(entries), observations: observations.source, config: {} as never });
    interceptorOf(gateway).setDispatcher('main-1', 'bot-1', queue);
    const result: ToolEntry = { t: 'tool', ts: 2, toolUseId: 'read-1', ok: true,
      result: [{ type: 'image_ref', path: '/output/read.png', size: 68, mediaType: 'image/png' }] };
    observations.publisher.conversationAppended({ agentId: 'child-1', index: 1, entry: result });
    observations.publisher.conversationAppended({ agentId: 'main-1', index: 1, entry: result });
    observations.publisher.outputObserved({ agentId: 'main-1', type: 'turn_end' });
    queue.markComplete();
    await queue.waitForIdle();
    observations.publisher.conversationAppended({ agentId: 'main-1', index: 2, entry: {
      ...result, toolUseId: 'generate-1', ok: false,
      result: [{ type: 'text', text: '<error>部分成功\n- [成功] "/output/generated.png"\n- [失败] "/output/failed.png"</error>' }],
    } });
    await queue.waitForIdle();
    expect(deliver.mock.calls).toEqual([
      [{ mediaUrls: ['/output/read.png'] }, { kind: 'tool' }],
      [{ mediaUrls: ['/output/generated.png'] }, { kind: 'tool' }],
    ]);
    await gateway.destroy();
  });

  it('applies image configuration and tool filters while keeping ask_user images as input', async () => {
    const interceptor = new ReplyInterceptor();
    const deliver = vi.fn(async () => {});
    const queue = createDeliveryQueue({ deliver });
    const result: ToolEntry = { t: 'tool', ts: 2, toolUseId: 'tool-1', ok: true,
      result: [{ type: 'image_ref', path: '/output/image.png', size: 68, mediaType: 'image/png' }] };
    const config = { forwardAssistantText: false, forwardToolCalls: false, forwardToolResults: false };
    interceptor.setDispatcher('main-1', 'bot-1', queue, { ...config, forwardToolImages: false });
    interceptor.processToolImages('main-1', result, () => 'read');
    interceptor.setDispatcher('main-1', 'bot-1', queue, { ...config, toolFilter: { mode: 'exclude', tools: ['read'] } });
    interceptor.processToolImages('main-1', result, () => 'read');
    interceptor.processToolImages('main-1', result, () => 'ask_user');
    interceptor.setDispatcher('main-1', 'bot-1', queue, config);
    interceptor.processToolImages('main-1', result, () => 'read');
    interceptor.processToolImages('main-1', result, () => 'read');
    queue.markComplete();
    await queue.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('forwards only top-level output and cleans a released runtime binding', () => {
    const gateway = new IMGateway();
    const observations = createAgentObservations();
    const interceptor = interceptorOf(gateway);
    const process = vi.spyOn(interceptor, 'processStateEvent').mockImplementation(() => undefined);
    const remove = vi.spyOn(interceptor, 'removeBinding').mockImplementation(() => undefined);
    gateway.injectDependencies({
      agentService: fakeAgentService(),
      observations: observations.source,
      config: {} as never,
    });

    observations.publisher.outputObserved({
      agentId: 'main-1',
      type: 'assistant_text',
      content: 'main output',
    });
    observations.publisher.outputObserved({
      agentId: 'child-1',
      type: 'assistant_text',
      content: 'child output',
    });
    observations.publisher.liveContentObserved({
      agentId: 'main-1',
      requestId: 'request-1',
      runId: 'run-1',
      sequence: 1,
      kind: 'text',
      delta: 'must stay inside the renderer live channel',
    });
    observations.publisher.runtimeReleased({
      agentId: 'main-1',
      reason: 'stopped',
    });

    expect(process).toHaveBeenCalledOnce();
    expect(process).toHaveBeenCalledWith(
      'main-1',
      expect.objectContaining({ content: 'main output' }),
    );
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('main-1');
  });

  it('rebinds without duplicate listeners and detaches on destroy', async () => {
    const gateway = new IMGateway();
    const observations = createAgentObservations();
    const interceptor = interceptorOf(gateway);
    const process = vi.spyOn(interceptor, 'processStateEvent').mockImplementation(() => undefined);
    const dependencies = {
      agentService: fakeAgentService(),
      observations: observations.source,
      config: {} as never,
    };

    gateway.injectDependencies(dependencies);
    gateway.injectDependencies(dependencies);
    observations.publisher.outputObserved({ agentId: 'main-1', type: 'turn_end' });
    expect(process).toHaveBeenCalledOnce();

    await gateway.destroy();
    observations.publisher.outputObserved({ agentId: 'main-1', type: 'turn_end' });
    expect(process).toHaveBeenCalledOnce();
  });
});
