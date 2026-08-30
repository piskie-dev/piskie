import { describe, expect, it } from 'vitest';
import type { ToolInputSchema } from '../../../../../shared/types/index.js';
import type { ReasoningProfile } from '../../../../../shared/types/reasoning.js';
import type { AiRequest } from '../../../ai/contracts.js';
import {
  AnthropicSerializationError,
  mapAnthropicMessagesRequest,
} from '../request-mapper.js';

const profile: ReasoningProfile = {
  mode: 'effort',
  options: [{ kind: 'effort', effort: 'low' }, { kind: 'effort', effort: 'high' }],
  defaultSelection: { kind: 'effort', effort: 'high' },
  mandatory: true,
  transportPreset: 'anthropic-adaptive-effort',
  replayPolicy: 'visible',
};

const actionSchema: ToolInputSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['create', 'list'] },
    taskDescription: { type: 'string' },
  },
  required: ['action'],
  oneOf: [
    { properties: { action: { const: 'create' } }, required: ['action', 'taskDescription'] },
    { properties: { action: { const: 'list' } }, required: ['action'] },
  ],
};

function request(extensions?: Record<string, unknown>): AiRequest {
  return {
    model: { providerId: 'configured-provider', modelId: 'configured-binding' },
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hello' }] }],
    generation: { reasoning: { kind: 'effort', effort: 'high' } },
    ...(extensions && { extensions: { 'anthropic-messages': extensions } }),
  };
}

describe('Anthropic Messages request mapper', () => {
  it('leaves the Anthropic wire request unchanged when an OpenAI prompt cache key is present', async () => {
    const options = {
      assistantReasoningReplay: 'omit' as const,
      promptCaching: true,
      reasoningProfile: profile,
    };
    const baseline = await mapAnthropicMessagesRequest(request(), 'wire-model', options);
    const keyed = await mapAnthropicMessagesRequest(
      { ...request(), promptCacheKey: 'agent-cache-key' },
      'wire-model',
      options,
    );

    expect(keyed).toEqual(baseline);
  });

  it('serializes the exact compiled upstream model and merges adaptive effort fields', async () => {
    const mapped = await mapAnthropicMessagesRequest(
      request({ metadata: { user_id: 'local-user' } }),
      'wire-model-selected-by-user',
      {
        assistantReasoningReplay: 'omit',
        promptCaching: true,
        reasoningProfile: profile,
      },
    );

    expect(mapped).toMatchObject({
      model: 'wire-model-selected-by-user',
      metadata: { user_id: 'local-user' },
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
  });

  it('preserves the canonical object and branch constraints on the wire', async () => {
    const mapped = await mapAnthropicMessagesRequest(
      {
        ...request(),
        tools: [{ name: 'flow', description: 'Manage flows', inputSchema: actionSchema }],
      },
      'wire-model-selected-by-user',
      {
        assistantReasoningReplay: 'omit',
        promptCaching: false,
        reasoningProfile: profile,
      },
    );

    expect(mapped.tools).toEqual([{
      name: 'flow',
      description: 'Manage flows',
      input_schema: actionSchema,
    }]);
  });

  it('projects every canonical generation option without changing its value', async () => {
    const mapped = await mapAnthropicMessagesRequest(
      {
        ...request(),
        generation: {
          maxOutputTokens: 32_000,
          temperature: 0.3,
          topP: 0.85,
          stop: ['DONE'],
          reasoning: { kind: 'effort', effort: 'high' },
        },
      },
      'wire-model-selected-by-user',
      {
        assistantReasoningReplay: 'omit',
        promptCaching: false,
        reasoningProfile: profile,
      },
    );

    expect(mapped).toMatchObject({
      max_tokens: 32_000,
      temperature: 0.3,
      top_p: 0.85,
      stop_sequences: ['DONE'],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
  });

  it('uses an internal protocol fallback only when maxOutputTokens is absent', async () => {
    const mapped = await mapAnthropicMessagesRequest(
      { ...request(), generation: undefined },
      'wire-model-selected-by-user',
      {
        assistantReasoningReplay: 'omit',
        promptCaching: false,
        reasoningProfile: profile,
      },
    );

    expect(mapped.max_tokens).toBe(8_192);
  });

  it('merges consecutive tool results into one user message so tool_use pairing survives', async () => {
    const req: AiRequest = {
      model: { providerId: 'p', modelId: 'm' },
      messages: [
        { role: 'user', content: [{ kind: 'text', text: '优化这个项目' }] },
        {
          role: 'assistant',
          content: [
            { kind: 'text', text: '先看结构' },
            { kind: 'tool_call', callId: 'call_00', name: 'ls', arguments: '{}' },
            { kind: 'tool_call', callId: 'call_01', name: 'shell', arguments: '{}' },
          ],
        },
        { role: 'tool', toolCallId: 'call_00', content: [{ kind: 'text', text: 'listing' }] },
        { role: 'tool', toolCallId: 'call_01', content: [{ kind: 'text', text: '---' }] },
      ],
    };

    const mapped = await mapAnthropicMessagesRequest(req, 'wire-model', {
      assistantReasoningReplay: 'omit',
      promptCaching: false,
    });

    expect(mapped.messages).toHaveLength(3);
    const last = mapped.messages[2]!;
    expect(last.role).toBe('user');
    const ids = (last.content as Array<{ type: string; tool_use_id?: string }>)
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.tool_use_id);
    expect(ids).toEqual(['call_00', 'call_01']);
  });

  it('merges trailing user text after tool results into the same user message', async () => {
    const req: AiRequest = {
      model: { providerId: 'p', modelId: 'm' },
      messages: [
        {
          role: 'assistant',
          content: [{ kind: 'tool_call', callId: 'call_00', name: 'ls', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'call_00', content: [{ kind: 'text', text: 'listing' }] },
        { role: 'user', content: [{ kind: 'text', text: '补充说明' }] },
      ],
    };

    const mapped = await mapAnthropicMessagesRequest(req, 'wire-model', {
      assistantReasoningReplay: 'omit',
      promptCaching: false,
    });

    expect(mapped.messages).toHaveLength(2);
    const types = (mapped.messages[1]!.content as Array<{ type: string }>).map((block) => block.type);
    expect(types).toEqual(['tool_result', 'text']);
  });

  it('merges consecutive assistant messages without reordering thinking or tool blocks', async () => {
    const req: AiRequest = {
      model: { providerId: 'p', modelId: 'm' },
      messages: [
        { role: 'user', content: [{ kind: 'text', text: '继续' }] },
        {
          role: 'assistant',
          content: [
            {
              kind: 'reasoning',
              item: { protocol: 'anthropic-thinking', text: 'first', signature: 'sig-1' },
            },
            { kind: 'tool_call', callId: 'call_1', name: 'lookup', arguments: '{"id":"1"}' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { kind: 'reasoning', item: { protocol: 'anthropic-redacted', data: 'redacted-1' } },
            { kind: 'text', text: 'done' },
          ],
        },
      ],
    };

    const mapped = await mapAnthropicMessagesRequest(req, 'wire-model', {
      assistantReasoningReplay: 'omit',
      promptCaching: false,
    });

    expect(mapped.messages).toHaveLength(2);
    expect(mapped.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'first', signature: 'sig-1' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { id: '1' } },
        { type: 'redacted_thinking', data: 'redacted-1' },
        { type: 'text', text: 'done' },
      ],
    });
  });

  it('replays every signed and redacted thinking block without changing order', async () => {
    const req: AiRequest = {
      model: { providerId: 'p', modelId: 'm' },
      messages: [{
        role: 'assistant',
        content: [
          {
            kind: 'reasoning',
            item: { protocol: 'anthropic-thinking', text: 'first', signature: 'sig-1' },
          },
          {
            kind: 'reasoning',
            item: { protocol: 'anthropic-redacted', data: 'redacted-1' },
          },
          { kind: 'tool_call', callId: 'call_1', name: 'lookup', arguments: '{"id":"1"}' },
          {
            kind: 'reasoning',
            item: { protocol: 'anthropic-thinking', text: 'second', signature: 'sig-2' },
          },
        ],
      }],
    };

    const mapped = await mapAnthropicMessagesRequest(req, 'wire-model', {
      assistantReasoningReplay: 'omit',
      promptCaching: false,
    });

    expect(mapped.messages).toEqual([{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'first', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'redacted-1' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { id: '1' } },
        { type: 'thinking', thinking: 'second', signature: 'sig-2' },
      ],
    }]);
  });

  it('does not let an extension replace a controlled reasoning field', async () => {
    await expect(mapAnthropicMessagesRequest(
      request({ thinking: { type: 'disabled' } }),
      'wire-model-selected-by-user',
      {
        assistantReasoningReplay: 'omit',
        promptCaching: true,
        reasoningProfile: profile,
      },
    )).rejects.toMatchObject<Partial<AnthropicSerializationError>>({
      code: 'ANTHROPIC_EXTENSION_RESERVED',
    });
  });

  it('does not let a raw extension override the compiled cache policy', async () => {
    await expect(mapAnthropicMessagesRequest(
      request({ cache_control: { type: 'ephemeral', ttl: '1h' } }),
      'wire-model-selected-by-user',
      {
        assistantReasoningReplay: 'omit',
        promptCaching: false,
        reasoningProfile: profile,
      },
    )).rejects.toMatchObject<Partial<AnthropicSerializationError>>({
      code: 'ANTHROPIC_EXTENSION_RESERVED',
    });
  });
});

describe('thinking degradation for open tool turns without replayable thinking', () => {
  const deepseekProfile: ReasoningProfile = {
    mode: 'toggle',
    options: [{ kind: 'disabled' }, { kind: 'enabled' }],
    defaultSelection: { kind: 'enabled' },
    mandatory: false,
    transportPreset: 'deepseek-thinking',
    replayPolicy: 'opaque-required',
  };

  function thinkingEnabledRequest(messages: AiRequest['messages']): AiRequest {
    return {
      model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
      messages,
      generation: { reasoning: { kind: 'enabled' } },
    };
  }

  const openTurnFromAnotherProtocol: AiRequest['messages'] = [
    { role: 'user', content: [{ kind: 'text', text: '修复这个任务' }] },
    {
      role: 'assistant',
      content: [
        { kind: 'reasoning', item: { protocol: 'openai-chat', text: '之前模型的思考' } },
        { kind: 'tool_call', callId: 'call_1', name: 'readFile', arguments: '{}' },
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ kind: 'text', text: '文件内容' }] },
  ];

  it('disables thinking when the open tool turn came from another protocol', async () => {
    const mapped = await mapAnthropicMessagesRequest(
      thinkingEnabledRequest(openTurnFromAnotherProtocol),
      'deepseek-v4-flash',
      { assistantReasoningReplay: 'omit', promptCaching: false, reasoningProfile: deepseekProfile },
    );

    expect(mapped.thinking).toEqual({ type: 'disabled' });
  });

  it('disables thinking when the open tool turn has no reasoning at all', async () => {
    const mapped = await mapAnthropicMessagesRequest(
      thinkingEnabledRequest([
        { role: 'user', content: [{ kind: 'text', text: '继续' }] },
        {
          role: 'assistant',
          content: [{ kind: 'tool_call', callId: 'call_1', name: 'ls', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'call_1', content: [{ kind: 'text', text: 'listing' }] },
      ]),
      'deepseek-v4-flash',
      { assistantReasoningReplay: 'omit', promptCaching: false, reasoningProfile: deepseekProfile },
    );

    expect(mapped.thinking).toEqual({ type: 'disabled' });
  });

  it('keeps thinking enabled when the turn ends with a real user message', async () => {
    const mapped = await mapAnthropicMessagesRequest(
      thinkingEnabledRequest([
        ...openTurnFromAnotherProtocol,
        { role: 'assistant', content: [{ kind: 'text', text: '修好了' }] },
        { role: 'user', content: [{ kind: 'text', text: '很好，继续下一个' }] },
      ]),
      'deepseek-v4-flash',
      { assistantReasoningReplay: 'omit', promptCaching: false, reasoningProfile: deepseekProfile },
    );

    expect(mapped.thinking).toEqual({ type: 'enabled' });
  });

  it('keeps thinking enabled when the open tool turn carries its own signed thinking', async () => {
    const mapped = await mapAnthropicMessagesRequest(
      thinkingEnabledRequest([
        { role: 'user', content: [{ kind: 'text', text: '继续' }] },
        {
          role: 'assistant',
          content: [
            { kind: 'reasoning', item: { protocol: 'anthropic-thinking', text: '本家思考', signature: 'sig-1' } },
            { kind: 'tool_call', callId: 'call_1', name: 'ls', arguments: '{}' },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', content: [{ kind: 'text', text: 'listing' }] },
      ]),
      'deepseek-v4-flash',
      { assistantReasoningReplay: 'omit', promptCaching: false, reasoningProfile: deepseekProfile },
    );

    expect(mapped.thinking).toEqual({ type: 'enabled' });
    expect(mapped.messages[1]!.content).toEqual([
      { type: 'thinking', thinking: '本家思考', signature: 'sig-1' },
      { type: 'tool_use', id: 'call_1', name: 'ls', input: {} },
    ]);
  });

  it('strips signed thinking blocks from the whole request when degrading', async () => {
    const mapped = await mapAnthropicMessagesRequest(
      thinkingEnabledRequest([
        { role: 'user', content: [{ kind: 'text', text: '继续' }] },
        {
          role: 'assistant',
          content: [
            { kind: 'reasoning', item: { protocol: 'anthropic-thinking', text: '早先回合', signature: 'sig-old' } },
            { kind: 'tool_call', callId: 'call_1', name: 'ls', arguments: '{}' },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', content: [{ kind: 'text', text: 'listing' }] },
        {
          role: 'assistant',
          content: [{ kind: 'tool_call', callId: 'call_2', name: 'readFile', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'call_2', content: [{ kind: 'text', text: '内容' }] },
      ]),
      'deepseek-v4-flash',
      { assistantReasoningReplay: 'omit', promptCaching: false, reasoningProfile: deepseekProfile },
    );

    expect(mapped.thinking).toEqual({ type: 'disabled' });
    const blockTypes = mapped.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content.map((block) => block.type) : [],
    );
    expect(blockTypes).not.toContain('thinking');
    expect(blockTypes).not.toContain('redacted_thinking');
  });

  it('replays degraded thinking as plain text when the model options ask for as_text', async () => {
    const mapped = await mapAnthropicMessagesRequest(
      thinkingEnabledRequest(openTurnFromAnotherProtocol),
      'deepseek-v4-flash',
      { assistantReasoningReplay: 'as_text', promptCaching: false, reasoningProfile: deepseekProfile },
    );

    expect(mapped.thinking).toEqual({ type: 'disabled' });
    expect(mapped.messages[1]!.content).toEqual([
      { type: 'text', text: '之前模型的思考' },
      { type: 'tool_use', id: 'call_1', name: 'readFile', input: {} },
    ]);
  });

  it('does not degrade adaptive thinking because the server side handles the conflict', async () => {
    const mapped = await mapAnthropicMessagesRequest(
      {
        model: { providerId: 'anthropic', modelId: 'claude' },
        messages: openTurnFromAnotherProtocol,
        generation: { reasoning: { kind: 'effort', effort: 'high' } },
      },
      'claude-wire-model',
      { assistantReasoningReplay: 'omit', promptCaching: false, reasoningProfile: profile },
    );

    expect(mapped.thinking).toEqual({ type: 'adaptive' });
  });

  it('degrades budget thinking on manual-mode models with a foreign open tool turn', async () => {
    const budgetEnvironment: ReasoningProfile = {
      mode: 'budget',
      options: [{ kind: 'disabled' }, { kind: 'budget', tokens: 4096 }],
      defaultSelection: { kind: 'budget', tokens: 4096 },
      mandatory: false,
      transportPreset: 'anthropic-budget',
      replayPolicy: 'opaque-required',
    };
    const mapped = await mapAnthropicMessagesRequest(
      {
        model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
        messages: openTurnFromAnotherProtocol,
        generation: { reasoning: { kind: 'budget', tokens: 4096 } },
      },
      'claude-sonnet-4-5',
      { assistantReasoningReplay: 'omit', promptCaching: false, reasoningProfile: budgetEnvironment },
    );

    expect(mapped.thinking).toEqual({ type: 'disabled' });
  });
});
