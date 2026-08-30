import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test', on: () => undefined },
}));

vi.mock('../../services/paths.service.js', () => ({
  pathsService: {
    getDefaultWorkspaceDir: () => '/tmp/piskie-test/workspace',
    getTempDir: (agentId: string) => `/tmp/piskie-test/${agentId}`,
  },
}));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: { raise: vi.fn(), recover: vi.fn() },
}));
vi.mock('../../agent-runs/compaction-archive.js', () => ({
  compactionArchive: { saveCompaction: vi.fn(), loadCompactions: vi.fn(() => []) },
}));

import { AIErrorType } from '../../../shared/constants/index.js';
import { RecordedAIRequestError } from '../../core/ai/ai-request-error.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { AgentRuntime } from '../agent-runtime.js';
import type { AgentSpec } from '../specs/spec.js';

describe('AgentRuntime worker AI failure notification', () => {
  it('forwards the recorded provider message without a runtime prefix', () => {
    const onNotification = vi.fn(() => true);
    const spec: AgentSpec = {
      name: 'notification-test-worker',
      role: 'worker',
      tools: { sdkGroups: [], customTools: [] },
      modules: [],
      buildSystemPrompt: () => '',
    };
    const runtime = new AgentRuntime({
      spec,
      inference: fakeAgentInference(),
      conversationStore: { append: vi.fn(), count: vi.fn(() => 0) } as never,
      options: {
        mainAgentId: 'parent-1',
        initialModel: 'provider::model',
        onNotification,
        subagentConfig: {
          mode: 'local',
          skills: [],
          subject: 'test',
          taskIds: ['task-1'],
          prompt: 'test',
        },
      },
    });
    const providerMessage = 'Your input exceeds the context window of this model.\n'
      + 'Please adjust your input and try again.';
    const error = new RecordedAIRequestError({
      message: providerMessage,
      errorType: AIErrorType.CONTEXT_OVERFLOW,
    }, new Error(providerMessage));

    (runtime as unknown as { handlePumpFailure(error: unknown): void }).handlePumpFailure(error);

    expect(onNotification).toHaveBeenCalledOnce();
    expect(onNotification).toHaveBeenCalledWith({
      type: 'failed',
      error: providerMessage,
      data: { origin: 'runtime' },
      failure: { errorType: AIErrorType.CONTEXT_OVERFLOW },
    });
  });
});
