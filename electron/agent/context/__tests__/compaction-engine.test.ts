import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
}));

import {
  COMPACTION_INSTRUCTION,
  CompactionEngine,
} from '../compaction-engine.js';
import { fakeAgentInference } from '../../../testing/fake-agent-inference.js';
import type {
  AgentInferenceRequest,
  AgentInferenceOptions,
} from '../../../inference/application/agent-inference-port.js';
import type { AIResponse, Message, Tool } from '../../../../shared/types/index.js';

const TARGET = { providerId: 'provider', modelId: 'model' };
const TOOLS: Tool[] = [{
  name: 'read',
  description: 'Read a file',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}];

const response = (content: AIResponse['content']): AIResponse => ({
  content,
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

function abortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

describe('CompactionEngine', () => {
  it('keeps proactive compaction at the configured 85% boundary', () => {
    const engine = new CompactionEngine(fakeAgentInference());

    expect(engine.shouldCompact(84.99)).toBe(false);
    expect(engine.shouldCompact(85)).toBe(true);
  });

  it('marks the appended instruction as control data without renaming All user messages', () => {
    expect(COMPACTION_INSTRUCTION).toMatch(/^<runtime_compaction_control>\n/);
    expect(COMPACTION_INSTRUCTION).toContain('本消息不属于待摘要对话');
    expect(COMPACTION_INSTRUCTION).toContain('只摘要本消息之前的内容');
    expect(COMPACTION_INSTRUCTION).toContain('CURRENT TASK 只能从此前对话确定');
    expect(COMPACTION_INSTRUCTION).toContain('6. **All user messages:**');
    expect(COMPACTION_INSTRUCTION).toMatch(/<\/runtime_compaction_control>$/);
  });

  it('keeps the work request shape and complete history, then appends one user instruction', async () => {
    const history: Message[] = [
      { role: 'user', subtype: 'assignment', content: '<assignment>three goals</assignment>' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call-1',
          name: 'read',
          input: { path: '/tmp/complete-arguments', nested: { keep: true } },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: 'x'.repeat(2_000),
        }],
      },
    ];
    const invoke = vi.fn(async () => response([{
      type: 'text',
      text: '# Compact summary\n\n**CURRENT TASK**: finish goal three',
    }]));
    const engine = new CompactionEngine(fakeAgentInference({ invoke }));
    const request = {
      systemPrompt: 'ORIGINAL SYSTEM',
      tools: TOOLS,
      model: TARGET,
      reasoningOverride: { kind: 'effort' as const, effort: 'high' as const },
      promptCacheKey: 'agent-compaction',
    };

    const result = await engine.compact(history, 122, 180_000, request);

    expect(result).toMatchObject({
      success: true,
      compressedCount: 122,
      summary: {
        markdown: '# Compact summary\n\n**CURRENT TASK**: finish goal three',
        compressedCount: 122,
        originalTokens: 180_000,
      },
    });
    expect(result).not.toHaveProperty('remainingMessages');
    const sent = invoke.mock.calls[0][0] as AgentInferenceRequest;
    expect(sent).toMatchObject(request);
    expect(sent.messages.slice(0, -1)).toEqual(history);
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: COMPACTION_INSTRUCTION });
    expect(JSON.stringify(sent.messages)).toContain('/tmp/complete-arguments');
    expect(JSON.stringify(sent.messages)).toContain('x'.repeat(2_000));
  });

  it('does not protect Assignment, task calls, or a long suffix from the summary request', async () => {
    const history: Message[] = [
      { role: 'user', subtype: 'assignment', content: 'ASSIGNMENT' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'task-1', name: 'task', input: { items: [] } }],
      },
      ...Array.from({ length: 120 }, (_, index): Message => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}`,
      })),
    ];
    const invoke = vi.fn(async () => response([{ type: 'text', text: '# Compact summary' }]));
    const engine = new CompactionEngine(fakeAgentInference({ invoke }));

    await engine.compact(history, history.length, 170_000, {
      systemPrompt: 'system',
      tools: TOOLS,
      model: TARGET,
    });

    const sent = invoke.mock.calls[0][0] as AgentInferenceRequest;
    expect(sent.messages.slice(0, -1)).toEqual(history);
    expect(sent.messages).toHaveLength(history.length + 1);
  });

  it('passes the turn signal through and settles without committing when aborted', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const invoke = vi.fn((_request: AgentInferenceRequest, options?: AgentInferenceOptions) => {
      receivedSignal = options?.signal;
      return new Promise<AIResponse>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    });
    const engine = new CompactionEngine(fakeAgentInference({ invoke }));
    const pending = engine.compact(
      [{ role: 'user', content: 'history' }],
      1,
      1_000,
      { systemPrompt: 'system', tools: TOOLS, model: TARGET },
      controller.signal,
    );

    await Promise.resolve();
    controller.abort();

    await expect(pending).resolves.toMatchObject({ success: false, reason: expect.stringContaining('aborted') });
    expect(receivedSignal).toBe(controller.signal);
  });

  it('rejects empty text and tool-calling responses without executing tools', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([{
        type: 'tool_use', id: 'bad', name: 'read', input: { path: '/tmp/a' },
      }]));
    const engine = new CompactionEngine(fakeAgentInference({ invoke }));
    const args = [
      [{ role: 'user', content: 'history' }],
      1,
      1_000,
      { systemPrompt: 'system', tools: TOOLS, model: TARGET },
    ] as const;

    await expect(engine.compact(...args)).resolves.toMatchObject({ success: false });
    await expect(engine.compact(...args)).resolves.toMatchObject({
      success: false,
      reason: expect.stringContaining('called a tool'),
    });
  });
});
