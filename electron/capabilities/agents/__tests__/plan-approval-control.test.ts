import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sample-profile', on: vi.fn() } }));
vi.mock('../../../core/pilot/index.js', () => ({ agentPilotPorts: {}, browserControlPort: {} }));

import { AGENT_OPERATIONS } from '../../../../shared/electron-contracts/agents.js';
import type { PendingToolCall } from '../../../../shared/types/index.js';
import { AgentService } from '../../../services/agent.service.js';
import { AgentRuntime } from '../../../agent/agent-runtime.js';
import { SubagentModule } from '../../../agent/modules/subagent.module.js';
import { ConversationStore } from '../../../agent-runs/conversation-store.js';
import { fakeAgentInference } from '../../../testing/fake-agent-inference.js';
import { createElectronPiskieClient } from '../../../transport/electron/piskie-client.js';
import type { ElectronPreloadClient } from '../../../transport/electron/preload-client.js';
import { createAgentCommands } from '../../../../src/domains/agent-control/agent-commands.js';
import { createAgentControlStore } from '../../../../src/domains/agent-control/agent-control-store.js';
import { createAgentController } from '../agent-controller.js';
import type { ControllerContext } from '../../catalog.js';

let directory: string;
let main: AgentRuntime;
let child: AgentRuntime;
let service: AgentService;
let commands: ReturnType<typeof createAgentCommands>;
let operations: ReturnType<typeof createAgentController>['operations'];
let request: ReturnType<typeof vi.fn>;
const mainId = 'sample-main';
const workerId = 'sample-worker';
const context: ControllerContext = {
  generation: 'sample-generation', connectionId: 'sample-connection', windowId: 1,
  signal: new AbortController().signal,
};
const pending = (runtime: AgentRuntime, id = 'sample-plan'): PendingToolCall => ({
  id, agentId: runtime.id, mainAgentId: mainId, toolName: 'plan',
  params: { action: 'create', taskSummary: 'Sample plan' }, modeInvariant: true,
  category: 'system', description: 'Review sample plan', timestamp: new Date(),
});

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-control-'));
  vi.useFakeTimers();
  const store = new ConversationStore(directory);
  const runtime = (id: string, role: 'director' | 'worker') => new AgentRuntime({
    id,
    spec: {
      name: role === 'director' ? 'sample-director' : 'sample-worker', role,
      modules: role === 'director' ? ['subagent'] : [],
      tools: { sdkGroups: [], customTools: [] }, buildSystemPrompt: () => 'Sample instructions.',
    },
    inference: fakeAgentInference(), conversationStore: store,
    options: {
      mainAgentId: mainId, initialModel: 'sample::model', initialApprovalMode: 'auto',
      runConfig: { name: 'Sample task', description: '', promptTemplate: '', workspace: directory },
      workspace: directory,
      ...(role === 'worker' ? { subagentConfig: {
        type: 'local-worker', subject: 'Sample task', prompt: 'Sample task', skills: [], taskIds: [],
      } } : {}),
    },
  });
  main = runtime(mainId, 'director');
  child = runtime(workerId, 'worker');
  const module = main.getModule<SubagentModule>('subagent')!;
  (module as unknown as { subagents: Map<string, AgentRuntime> }).subagents.set(workerId, child);
  service = new AgentService();
  (service as unknown as { activeRuntimes: Map<string, AgentRuntime> }).activeRuntimes.set(mainId, main);
  operations = createAgentController(service, {} as never).operations;
  request = vi.fn(async (operationId: string, args: unknown[]) => {
    const operation = operations.find(({ id }) => id === operationId)!;
    return operation.execute(context, operation.input.parse(args));
  });
  const client = createElectronPiskieClient({
    transport: { request, subscribe: vi.fn() } as unknown as ElectronPreloadClient,
    version: 'sample', platform: 'linux',
  });
  commands = createAgentCommands(client.agents, createAgentControlStore(), {} as never);
});

afterEach(async () => {
  await main.destroy();
  await child.destroy();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('plan approval public control path', () => {
  it.each([undefined, workerId])('cancels only the requested target (%s) through commands, transport and runtime', async (subagentId) => {
    const mainSettled = vi.fn();
    const childSettled = vi.fn();
    void main.handleApprovalRequest(pending(main)).then(mainSettled);
    void child.handleApprovalRequest(pending(child)).then(childSettled);
    const target = subagentId ? child : main;
    const other = subagentId ? main : child;
    const stateChanged = vi.spyOn(target, 'emitStateChange');
    const originalDeadline = other.getControlState().pendingToolCall?.autoApproveAt;

    await expect(commands.cancelPlanApprovalCountdown(mainId, subagentId, 'sample-plan')).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledExactlyOnceWith(AGENT_OPERATIONS.cancelPlanApprovalCountdown, [mainId, subagentId, 'sample-plan']);
    expect(stateChanged).toHaveBeenCalled();
    expect(target.getControlState().pendingToolCall?.autoApproveAt).toBeUndefined();
    expect(other.getControlState().pendingToolCall?.autoApproveAt).toBe(originalDeadline);
    expect(target.approvalMode).toBe('auto');
    const projected = main.getControlState();
    expect((subagentId ? projected.children[0] : projected)?.pendingToolCall?.autoApproveAt).toBeUndefined();
    await commands.cancelPlanApprovalCountdown(mainId, subagentId, 'sample-plan');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(subagentId ? childSettled : mainSettled).not.toHaveBeenCalled();
    expect(subagentId ? mainSettled : childSettled).toHaveBeenCalledExactlyOnceWith({ callId: 'sample-plan', decision: 'allow' });
    await expect(commands.respondToApproval(mainId, subagentId, { callId: 'sample-plan', decision: 'allow' })).resolves.toMatchObject({ ok: true });
    expect(target.getControlState().pendingToolCall).toBeUndefined();
  });

  it.each([
    ['unknown-main', undefined, 'sample-plan'],
    [mainId, 'unknown-worker', 'sample-plan'],
    [mainId, undefined, 'unknown-plan'],
  ] as const)('returns a public failure for an unavailable cancellation target %s/%s/%s', async (agentId, subagentId, callId) => {
    await expect(commands.cancelPlanApprovalCountdown(agentId, subagentId, callId)).resolves.toEqual({
      ok: false, error: 'Agent or pending plan approval was not found',
    });
  });

  it('validates cancellation identifiers at the public input boundary', () => {
    const operation = operations.find(({ id }) => id === AGENT_OPERATIONS.cancelPlanApprovalCountdown)!;
    expect(operation.input.safeParse([mainId, undefined, 'sample-plan']).success).toBe(true);
    expect(operation.input.safeParse([mainId, workerId, 'sample-plan']).success).toBe(true);
    expect(operation.input.safeParse([mainId, undefined, '']).success).toBe(false);
    expect(operation.input.safeParse([mainId, workerId, 42]).success).toBe(false);
  });

  it('routes rejection through recoverable main interruption and clears its child approvals', async () => {
    main.addDurableUserMessage('Sample context to retain');
    const before = main.getControlState().conversationLength;
    const mainApproval = main.handleApprovalRequest(pending(main));
    const childApproval = child.handleApprovalRequest(pending(child));
    const respond = vi.spyOn(service, 'respondToApproval');
    const stop = vi.spyOn(service, 'stopAgent');
    const interrupt = vi.spyOn(main, 'instantInterrupt');
    await expect(commands.interrupt(mainId)).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledExactlyOnceWith(AGENT_OPERATIONS.interrupt, [mainId]);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(respond).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    await expect(mainApproval).resolves.toMatchObject({ decision: 'deny' });
    await expect(childApproval).resolves.toMatchObject({ decision: 'deny' });
    expect(main.getControlState().pendingToolCall).toBeUndefined();
    expect(child.getControlState().pendingToolCall).toBeUndefined();
    expect(main.interrupted).toBe(true);
    expect(child.interrupted).toBe(true);
    expect(service.hasAgentInMemory(mainId)).toBe(true);
    expect(main.getControlState().conversationLength).toBe(before);
    expect(main.getConversationStore().read(mainId, mainId)).toContainEqual(expect.objectContaining({
      t: 'msg', role: 'user', content: 'Sample context to retain',
    }));
  });

  it('routes worker rejection to that worker and preserves the parent approval', async () => {
    const mainApproval = main.handleApprovalRequest(pending(main));
    const childApproval = child.handleApprovalRequest(pending(child));
    // Keep the parent at its approval while the existing worker-interrupted notification is queued.
    const post = vi.spyOn(main, 'post').mockReturnValue(true);
    await expect(commands.interruptSubagent(mainId, workerId)).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledExactlyOnceWith(AGENT_OPERATIONS.interruptSubagent, [mainId, workerId]);
    await expect(childApproval).resolves.toMatchObject({ decision: 'deny' });
    expect(child.interrupted).toBe(true);
    expect(main.interrupted).toBe(false);
    expect(main.getControlState().pendingToolCall?.autoApproveAt).toBeDefined();
    expect(post).toHaveBeenCalledOnce();
    await main.instantInterrupt();
    await mainApproval;
  });
});
