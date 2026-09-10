import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const environment = vi.hoisted(() => ({ userData: '', workspace: '', temp: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => environment.userData, on: vi.fn() },
}));
vi.mock('../../services/paths.service.js', () => ({ pathsService: {
  getDefaultWorkspaceDir: () => environment.workspace,
  getTempDir: () => environment.temp,
  ensureTempDir: vi.fn(async () => undefined),
  ensureWorkspace: vi.fn(async () => undefined),
} }));

import { AgentRuntime } from '../agent-runtime.js';
import type { AgentSpec } from '../specs/spec.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-instructions-'));
  environment.userData = path.join(root, 'profile');
  environment.workspace = path.join(root, 'default-workspace');
  environment.temp = path.join(root, 'temp');
  await fs.mkdir(environment.userData);
  await fs.mkdir(environment.workspace);
  await fs.writeFile(path.join(environment.userData, 'AGENTS.md'), 'Global rules.');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function createRuntime(role: 'director' | 'worker', workspace?: string, isResume = false, runtimeWorkspace?: string) {
  const spec: AgentSpec = {
    name: `${role}-test`, role, modules: [],
    tools: { sdkGroups: [], customTools: [] },
    buildSystemPrompt: () => 'System rules.',
  };
  const runtime = new AgentRuntime({
    id: `${role}-sample`, spec, inference: fakeAgentInference(),
    conversationStore: { append: vi.fn(), count: () => 0 } as never,
    options: {
      mainAgentId: 'sample-main', initialModel: 'sample::model', isResume,
      runConfig: { name: 'Sample', description: '', promptTemplate: 'Sample task', workspace },
      workspace: runtimeWorkspace,
      ...(role === 'worker' ? { subagentConfig: {
        type: 'local-worker', skills: [], subject: 'Sample task', taskIds: [], prompt: 'Sample task',
      } } : {}),
    },
  });
  vi.spyOn(runtime as unknown as { prepareMcpSession(): Promise<void> }, 'prepareMcpSession')
    .mockResolvedValue(undefined);
  return runtime;
}

describe('Runtime instruction initialization', () => {
  it.each(['director', 'worker'] as const)('loads %s instructions before its first task and reuses them', async (role) => {
    const workspace = path.join(root, 'project');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'Initial project rules.');
    const runtime = createRuntime(role, workspace, false, path.join(root, 'unused-fallback'));
    await runtime.prepare();
    const initial = runtime.buildContextSnapshot();
    expect(initial.systemPrompt).toBe('System rules.');
    expect(initial.messages[0]).toMatchObject({ role: 'user', subtype: 'agent_instructions' });
    expect(initial.messages[0].content).toContain('Global rules.');
    expect(initial.messages[0].content).toContain('Initial project rules.');
    expect(initial.messages[1].subtype).toBe(role === 'worker' ? 'assignment' : 'system_task');

    await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'Updated project rules.');
    runtime.addUserMessage({ text: 'Follow-up task' });
    await runtime.prepare();
    expect(runtime.buildContextSnapshot().messages[0]).toEqual(initial.messages[0]);
    expect(runtime.buildContextSnapshot().messages.filter((message) => message.subtype === 'agent_instructions'))
      .toHaveLength(1);

    const restored = createRuntime(role, workspace, true);
    restored.addUserMessage({ text: 'Restored task' });
    await restored.prepare();
    expect(restored.buildContextSnapshot().messages[0].content).toContain('Updated project rules.');
    expect(restored.buildContextSnapshot().messages[1].content).toBe('Restored task');
  });

  it.each(['runtime', 'default'])('uses the same %s workspace for instructions and tool configuration', async (source) => {
    const selected = source === 'runtime' ? path.join(root, 'selected-project') : environment.workspace;
    await fs.mkdir(selected, { recursive: true });
    await fs.writeFile(path.join(selected, 'AGENTS.md'), 'Selected workspace rules.');
    const runtime = createRuntime('worker', undefined, false, source === 'runtime' ? selected : undefined);
    await runtime.prepare();
    expect(runtime.buildContextSnapshot().messages[0].content).toContain('Selected workspace rules.');
    const activation = (runtime as unknown as {
      createToolContext(): { runConfig: { workspace: string }; workspace: { dir: string } };
    }).createToolContext();
    expect(activation.workspace.dir).toBe(selected);
    expect(activation.runConfig.workspace).toBe(selected);
  });
});
