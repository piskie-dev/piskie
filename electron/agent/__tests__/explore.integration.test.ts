import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInferenceRequest } from '../../inference/application/agent-inference-port.js';
import type { AgentHost } from '../agent-host.js';
import type { AgentInputRequest, ContentBlock } from '../../../shared/types/index.js';

const fixture = vi.hoisted(() => ({ root: '', createMcpSession: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sample-explore-app', getAppPath: () => '/tmp/sample-explore-app' } }));
vi.mock('../../services/paths.service.js', () => ({ pathsService: {
  getDefaultWorkspaceDir: () => fixture.root,
  getTempDir: (id: string) => `${fixture.root}/temp/${id}`,
  ensureTempDir: vi.fn(),
} }));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({ agentIncidentStore: { raise: vi.fn(), recover: vi.fn() } }));
vi.mock('../../mcp/runtime/index.js', () => ({ mcpConnectionManager: { createSession: fixture.createMcpSession } }));

import { ConversationStore } from '../../agent-runs/conversation-store.js';
import { taskBoardService } from '../../agent-runs/task-board-service.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { ToolContextBuilder } from '../tool-context.js';
import { ToolCallContextFactory } from '../tool-call/context-builder.js';
import { ToolCoordinator } from '../../tools/coordinator.js';
import { getStandaloneToolCatalog } from '../../tools/index.js';
import { specRegistry } from '../specs/index.js';
import { SubagentModule } from '../modules/subagent.module.js';
import type { AgentRuntime } from '../agent-runtime.js';

beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'sample-explore-'));
  fixture.createMcpSession.mockReset().mockImplementation(async () => ({
    sessionRuntimeId: 'sample-session', ownerId: 'worker-a', ownerKind: 'worker',
    capability: { projectContextId: 'sample-project', workspace: fixture.root, servers: [], blocked: [], warnings: [], fingerprint: 'empty' },
    startAll: vi.fn(), waitForInitialGrace: async () => undefined,
    catalogs: () => [], callTool: vi.fn(),
    view: () => ({ sessionRuntimeId: 'sample-session', total: 0, ready: 0, starting: 0, dormant: 0, failed: 0, blocked: 0, projectionRevision: 0, servers: [] }),
    onChange: () => () => undefined, retry: vi.fn(), release: async () => undefined,
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(fixture.root, { recursive: true, force: true });
});

describe('Explore through the existing Worker runtime', () => {
  it.each(['normal', 'plan'] as const)('creates from %s without a task board, reads evidence and accepts a follow-up', async (modeId) => {
    const boardSnapshot = vi.spyOn(taskBoardService, 'createCompactSnapshot');
    const releaseTasks = vi.spyOn(taskBoardService, 'releaseOwnerTasks');
    const source = path.join(fixture.root, 'settings.ts');
    await fs.writeFile(source, 'export const saveTarget = "settings.json";\n');
    const store = new ConversationStore(fixture.root);
    const runConfig = { name: 'Sample investigation', description: '', promptTemplate: 'PARENT_PRIVATE_CONTEXT', workspace: fixture.root, mcpServers: ['sample-server'] };
    store.writeHeader('parent-a', {
      agentId: 'parent-a', agentSpec: 'director', modeId, runConfig,
      createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      currentModel: 'sample::model', approvalMode: 'auto', childAgents: [],
    });
    const requests: AgentInferenceRequest[] = [];
    const defaultInference = fakeAgentInference();
    const inference = fakeAgentInference({ invoke: async (request, options) => {
      requests.push(request);
      const step = requests.length;
      const content: ContentBlock[] = [{ type: 'tool_use', id: `call-${step}`,
        name: step === 1 ? 'read' : 'send_event',
        input: step === 1 ? { file_path: source } : {
          type: 'completed', message: step === 2 ? `保存目标是 settings.json，依据 ${source}:1。` : '该常量由 settings.ts 导出，尚未执行验证。',
        },
      }];
      return { ...await defaultInference.invoke(request, options), content };
    } });
    const notifications: AgentInputRequest[] = [];
    const parentCapability = {
      projectContextId: 'sample-project', workspace: fixture.root, fingerprint: 'parent-capability', blocked: [], warnings: [],
      servers: [{ name: 'sample-server', origin: 'global-explicit', transport: 'stdio', config: { command: 'node' } }],
    };
    const module = new SubagentModule();
    const host = {
      id: 'parent-a', mainAgentId: 'parent-a', phase: 'running', spec: specRegistry.get('director')!,
      currentModel: 'sample::model', approvalMode: 'auto',
      getInference: () => inference, getConversationStore: () => store,
      getMcpCapabilitySnapshot: () => parentCapability,
      appendConversationEntry: (entry: Parameters<ConversationStore['append']>[2]) => store.append('parent-a', 'parent-a', entry),
      emitStateChange: vi.fn(), post: (event: AgentInputRequest) => { notifications.push(event); return true; },
    } as unknown as AgentHost;
    module.init(host, { inference, runConfig, allocateAgentId: () => 'worker-a' });
    const builder = new ToolContextBuilder().setAgentInfo({ agentId: 'parent-a', mainAgentId: 'parent-a', agentSpec: 'director', role: 'director', runConfig })
      .setModes({ modeId: () => modeId, approvalMode: () => 'auto' });
    module.contributeTools(builder);
    const ports = builder.build();
    const contexts = new ToolCallContextFactory({ signal: () => new AbortController().signal, activation: {
      agentType: 'main', agentSpec: 'director', agentId: 'parent-a', mainAgentId: 'parent-a', runConfig,
      resourceIds: {}, currentModel: () => 'sample::model', workspace: { dir: fixture.root, tempDir: fixture.root },
      modes: ports.modes, subagents: ports.subagents, events: ports.events, post: () => true,
    } });
    const coordinator = new ToolCoordinator({ contexts });
    const snapshot = getStandaloneToolCatalog().snapshot({
      scope: 'main', agentType: 'main', customTools: ['subagent', 'send_event'], exposedSkillFunctions: [],
      excluded: new Set(), domains: new Set(['local']), subagentTypes: specRegistry.getWorkersForParent('director'),
    });
    try {
      const created = await coordinator.run({ modelName: 'subagent', callId: 'create-a', rawParams: {
        type: 'explore', subject: '查明保存目标', prompt: `阅读 ${source}，查明保存目标并给出文件与行号。`,
      } }, snapshot);
      expect(created).toMatchObject({ result: { ok: true } });
      await vi.waitFor(() => expect(notifications).toHaveLength(1));
      expect(notifications[0]).toMatchObject({ source: 'subagent', content: {
        subagentId: 'worker-a', type: 'completed', text: expect.stringContaining(`${source}:1`),
      } });
      expect(JSON.stringify(requests[1].messages)).toContain('export const saveTarget');
      expect(JSON.stringify(requests[0].messages)).not.toContain('PARENT_PRIVATE_CONTEXT');
      expect(JSON.stringify(requests[0].messages)).not.toContain('<task_board');
      expect(requests[0].tools?.map((tool) => tool.name).sort()).toEqual(['glob', 'grep', 'ls', 'read', 'send_event']);
      expect(requests[0].systemPrompt).toContain('区分源码直接证明的事实');
      expect(requests[0].systemPrompt).not.toMatch(/task 工具|need_user_action|<temp_dir>|shell=|## 技能与工具文档/);
      expect(fixture.createMcpSession).toHaveBeenCalledWith(expect.objectContaining({ selection: [], parentCapability }));
      expect(store.readHeader('parent-a')?.childAgents[0].config).toEqual({
        type: 'explore', subject: '查明保存目标', prompt: `阅读 ${source}，查明保存目标并给出文件与行号。`,
      });
      const worker = module.getSubagents().get('worker-a') as AgentRuntime;
      await vi.waitFor(() => expect(worker.isPumping).toBe(false));
      const followup = await coordinator.run({ modelName: 'send_event', callId: 'followup-a', rawParams: {
        type: 'message', targetId: 'worker-a', message: '补充说明常量的导出位置，以及是否执行过验证。',
      } }, snapshot);
      expect(followup).toMatchObject({ result: { ok: true } });
      await vi.waitFor(() => expect(notifications).toHaveLength(2));
      expect(notifications[1]).toMatchObject({ content: { type: 'completed', text: expect.stringContaining('尚未执行验证') } });
      await module.stopSubagentById('worker-a');
      expect(store.readHeader('parent-a')?.childAgents).toEqual([]);
      expect(boardSnapshot).not.toHaveBeenCalled();
      expect(releaseTasks).not.toHaveBeenCalled();
      expect(await fs.readFile(source, 'utf8')).toBe('export const saveTarget = "settings.json";\n');
    } finally {
      await module.onDestroy();
    }
  });
});
