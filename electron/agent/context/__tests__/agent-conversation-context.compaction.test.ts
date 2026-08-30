import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
}));
vi.mock('../../../agent-runs/compaction-archive.js', () => ({
  compactionArchive: {
    archiveOriginalMessages: vi.fn(async () => '/tmp/original-messages.json'),
  },
}));

import { AgentConversationContext } from '../agent-conversation-context.js';
import { COMPACTION_INSTRUCTION } from '../compaction-engine.js';
import { fakeAgentInference } from '../../../testing/fake-agent-inference.js';
import type { AgentInferenceRequest } from '../../../inference/application/agent-inference-port.js';
import type { AIResponse, Message, Tool } from '../../../../shared/types/index.js';
import type { AIRequestInfo } from '../../../../shared/types/context.js';

const TARGET = { providerId: 'p', modelId: 'm' };
const TOOLS: Tool[] = [{
  name: 'read',
  description: 'Read a file',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}];

const response = (markdown: string): AIResponse => ({
  content: [{ type: 'text', text: markdown }],
  requestInfo: {
    version: 1,
    requestId: 'compaction-request',
    runId: 'compaction-run',
    model: 'p::m',
    stopReason: 'end_turn',
    latencyMs: 1,
    usage: { inputTokens: 100, outputTokens: 20 },
  },
});

const requestInfo = (requestId: string): AIRequestInfo => ({
  version: 1,
  requestId,
  runId: `run-${requestId}`,
  model: 'p::m',
  usage: { inputTokens: 10_000, outputTokens: 100 },
  latencyMs: 1,
  stopReason: 'end_turn',
});

function serialized(messages: Message[]): string {
  return JSON.stringify(messages);
}

describe('AgentConversationContext compaction H/P boundary', () => {
  it('publishes the shared activity lifecycle when the 85% admission threshold compacts', async () => {
    const invoke = vi.fn().mockResolvedValue(response('# Compact summary\n\n继续当前任务。'));
    const manager = new AgentConversationContext({
      inference: fakeAgentInference({ invoke, contextWindow: () => 200_000 }),
      target: TARGET,
      mainAgentId: 'main-proactive-compaction',
    });
    const activity = vi.fn();

    manager.addUserMessage('需要压缩的已处理历史', 'assignment');
    const proactiveBoundary = manager.captureRequestBoundary();
    manager.commitSuccessfulRequest(proactiveBoundary, {
      ...requestInfo('turn-proactive'),
      usage: { inputTokens: 170_000 },
    });

    await manager.getMessagesForAI({
      systemPrompt: 'ORIGINAL SYSTEM',
      tools: TOOLS,
      model: TARGET,
      promptCacheKey: 'worker-proactive-compaction',
    }, undefined, activity);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(activity.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('summarizes processed Assignment while preserving pending messages verbatim across generations', async () => {
    const firstSummary = [
      '# Compact summary',
      '',
      '目标一和目标二已完成；CURRENT TASK 是完成目标三。',
    ].join('\n');
    const secondSummary = [
      '# Compact summary',
      '',
      '三个目标均已完成；CURRENT TASK 是处理最新用户输入。',
    ].join('\n');
    const invoke = vi.fn()
      .mockResolvedValueOnce(response(firstSummary))
      .mockResolvedValueOnce(response(secondSummary));
    const manager = new AgentConversationContext({
      inference: fakeAgentInference({ invoke, contextWindow: () => 200_000 }),
      target: TARGET,
      mainAgentId: 'main-compaction',
    });
    const request = {
      systemPrompt: 'ORIGINAL SYSTEM',
      tools: TOOLS,
      model: TARGET,
      reasoningOverride: { kind: 'effort' as const, effort: 'high' as const },
      promptCacheKey: 'worker-compaction',
    };

    manager.addUserMessage(
      '<assignment>目标一、目标二、目标三；当前已完成前两个。</assignment>',
      'assignment',
    );
    const assignmentBoundary = manager.captureRequestBoundary();
    manager.commitSuccessfulRequest(
      assignmentBoundary,
      requestInfo('turn-assignment')
    );

    manager.addAssistantMessage([{
      type: 'tool_use',
      id: 'pending-tool',
      name: 'read',
      input: { path: '/workspace/PENDING_FILE.md', keep: 'FULL_ARGUMENTS' },
    }], 'request-pending-tool');
    manager.appendToolResultProjection(
      'pending-tool',
      [{ type: 'text', text: 'PENDING_TOOL_RESULT' }],
      true,
      Date.now(),
    );

    await manager.getMessagesForAI(request);
    const firstCompacted = await manager.compactAfterOverflow();

    expect(firstCompacted).toBeDefined();
    expect(firstCompacted?.[0]).toMatchObject({
      role: 'user',
      subtype: 'context_summary',
      content: firstSummary,
    });
    expect(serialized(firstCompacted ?? [])).not.toContain('<assignment>');
    expect(serialized(firstCompacted ?? [])).toContain('/workspace/PENDING_FILE.md');
    expect(serialized(firstCompacted ?? [])).toContain('FULL_ARGUMENTS');
    expect(serialized(firstCompacted ?? [])).toContain('PENDING_TOOL_RESULT');

    const firstRequest = invoke.mock.calls[0]?.[0] as AgentInferenceRequest;
    expect(firstRequest).toMatchObject(request);
    expect(serialized(firstRequest.messages)).toContain('<assignment>');
    expect(serialized(firstRequest.messages)).not.toContain('PENDING_FILE.md');
    expect(firstRequest.messages.at(-1)).toEqual({
      role: 'user',
      content: COMPACTION_INSTRUCTION,
    });
    expect((manager as unknown as { consumedThrough: number }).consumedThrough).toBe(0);

    const toolBoundary = manager.captureRequestBoundary();
    manager.commitSuccessfulRequest(toolBoundary, requestInfo('turn-tool'));
    manager.addUserMessage('LATEST_PENDING_USER_INPUT');
    await manager.getMessagesForAI(request);

    const secondCompacted = await manager.compactAfterOverflow();
    const secondRequest = invoke.mock.calls[1]?.[0] as AgentInferenceRequest;

    expect(secondRequest.messages[0]).toMatchObject({
      subtype: 'context_summary',
      content: firstSummary,
    });
    expect(serialized(secondRequest.messages)).toContain('/workspace/PENDING_FILE.md');
    expect(serialized(secondRequest.messages)).toContain('PENDING_TOOL_RESULT');
    expect(serialized(secondRequest.messages)).not.toContain('<assignment>');
    expect(serialized(secondRequest.messages)).not.toContain('LATEST_PENDING_USER_INPUT');
    expect(secondCompacted).toEqual([
      { role: 'user', content: secondSummary, subtype: 'context_summary' },
      { role: 'user', content: 'LATEST_PENDING_USER_INPUT', subtype: 'user_input' },
    ]);
    expect((manager as unknown as { consumedThrough: number }).consumedThrough).toBe(0);
  });

  it('states the multi-goal progress requirement in the appended instruction', () => {
    expect(COMPACTION_INSTRUCTION).toContain('任务包含多个目标时逐项记录状态');
    expect(COMPACTION_INSTRUCTION).toContain('明确唯一或全部剩余目标');
    expect(COMPACTION_INSTRUCTION).toContain('不要把最初目标原样当成当前进度');
  });
});
