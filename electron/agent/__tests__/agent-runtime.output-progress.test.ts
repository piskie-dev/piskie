import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sample-profile', on: vi.fn() } }));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: { raise: vi.fn(), recover: vi.fn() },
}));
vi.mock('../../services/paths.service.js', () => ({
  pathsService: { getDefaultWorkspaceDir: () => '/workspace/sample' },
}));

import type { AIResponse } from '../../../shared/types/index.js';
import type { AgentInferenceOptions } from '../../inference/application/agent-inference-port.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { AgentRuntime } from '../agent-runtime.js';
import type { AgentModule } from '../modules/module.js';

class OutputRuntime extends AgentRuntime {
  request(): Promise<AIResponse> { return this.callAI('Sample instructions', [], []); }
  finishActivity(): void { this.publishInert(); }
}

describe('AgentRuntime activity output projection', () => {
  it('publishes independent Main and Worker streaming counts through the parent control state', async () => {
    const pending = new Map<string, {
      options: AgentInferenceOptions;
      resolve: (response: AIResponse) => void;
    }>();
    const inference = fakeAgentInference({ invoke: (request, options) => new Promise((resolve) => {
      pending.set(request.promptCacheKey, { options, resolve });
    }) });
    const store = { append: vi.fn(), count: () => 0, readHeader: () => null };
    const build = (role: 'director' | 'worker') => new OutputRuntime({
      id: role === 'director' ? 'sample-main' : 'sample-worker',
      spec: {
        name: `sample-${role}`, role, modules: [],
        tools: { sdkGroups: [], customTools: [] }, buildSystemPrompt: () => 'Sample instructions',
      },
      inference, conversationStore: store as never,
      options: {
        mainAgentId: 'sample-main', initialModel: 'sample::model',
        runConfig: { name: 'Sample activity', description: '', promptTemplate: '' },
        ...(role === 'worker' ? { subagentConfig: {
          type: 'local-worker', subject: 'Sample assignment', prompt: 'Sample assignment', skills: [],
        } } : {}),
      },
    });
    const main = build('director');
    const worker = build('worker');
    (main as unknown as { modules: AgentModule[] }).modules.push({
      id: 'sample-children', listChildAgents: () => [worker],
    } as unknown as AgentModule);
    const mainRequest = main.request();
    const workerRequest = worker.request();
    for (const [id, delta] of [['sample-main', 'abcd'], ['sample-worker', '{"id":2}']]) {
      const call = pending.get(id!)!;
      call.options.onOutputProgress?.({ kind: 'attempt-started', runId: `run-${id}`, attempt: 1 });
      call.options.onOutputProgress?.({ kind: 'delta', runId: `run-${id}`, attempt: 1, sequence: 2, delta: delta! });
    }
    const streaming = main.getControlState();
    expect(streaming.activeOutputTokens).toEqual({ count: 1, estimated: true });
    expect(streaming.children[0]?.activeOutputTokens).toEqual({ count: 2, estimated: true });

    for (const [id, outputTokens] of [['sample-main', 10], ['sample-worker', 20]] as const) {
      const call = pending.get(id)!;
      call.resolve({
        content: [{ type: 'text', text: 'Sample result' }],
        requestInfo: {
          version: 1, requestId: call.options.requestId, runId: `run-${id}`, model: 'sample::model',
          stopReason: 'end_turn', latencyMs: 100, usage: { outputTokens, reasoningTokens: 3 },
        },
      });
    }
    await Promise.all([mainRequest, workerRequest]);
    expect(main.getControlState().activeOutputTokens).toEqual({ count: 10, estimated: false });
    expect(main.getControlState().children[0]?.activeOutputTokens).toEqual({ count: 20, estimated: false });
    worker.finishActivity();
    expect(main.getControlState().children[0]?.activeOutputTokens).toBeUndefined();
    expect(main.getControlState().activeOutputTokens).toEqual({ count: 10, estimated: false });
    main.finishActivity();
    expect(main.getControlState().activeOutputTokens).toBeUndefined();
  });
});
