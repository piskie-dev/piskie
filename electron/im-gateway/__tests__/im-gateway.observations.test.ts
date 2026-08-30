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

function fakeAgentService() {
  return {
    hasAgentInMemory: vi.fn((agentId: string) => agentId === 'main-1'),
  } as unknown as AgentService;
}

function interceptorOf(gateway: IMGateway) {
  return (gateway as unknown as {
    replyInterceptor: {
      processStateEvent(agentId: string, event: unknown): void;
      removeBinding(agentId: string): void;
    };
  }).replyInterceptor;
}

describe('IMGateway Agent observation binding', () => {
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
