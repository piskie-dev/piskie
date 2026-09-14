import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/example-app', on: vi.fn() },
}));
vi.mock('../../services/paths.service.js', () => ({
  pathsService: {
    getDefaultWorkspaceDir: () => '/workspace',
    getTempDir: () => '/tmp/example-run',
  },
}));

import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { AgentRuntime } from '../agent-runtime.js';
import { specRegistry } from '../specs/index.js';

describe('AgentRuntime title rename', () => {
  it('updates the owned run config and publishes the revised control state', () => {
    const runConfig = {
      name: 'Original title',
      description: 'Original task description',
      promptTemplate: 'Original task prompt',
    };
    const onStateChange = vi.fn();
    const runtime = new AgentRuntime({
      id: 'sample-main',
      spec: { ...specRegistry.get('system-chat')!, modules: [] },
      inference: fakeAgentInference(),
      conversationStore: { append: vi.fn(), count: vi.fn(() => 0) } as never,
      onStateChange,
      options: {
        mainAgentId: 'sample-main',
        initialModel: 'sample::model',
        initialModeId: 'normal',
        initialApprovalMode: 'confirm',
        runConfig,
      },
    });

    runtime.setRunName('Revised title');

    expect(runConfig).toEqual({
      name: 'Revised title',
      description: 'Original task description',
      promptTemplate: 'Original task prompt',
    });
    expect(runtime.getControlState().runConfig).toBe(runConfig);
    expect(runtime.buildHeader().runConfig).toBe(runConfig);
    expect(onStateChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentId: 'sample-main',
      runConfig,
    }));
  });
});
