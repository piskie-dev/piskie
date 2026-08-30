import { describe, expect, it } from 'vitest';
import type { ToolInputSchema } from '../../../../../shared/types/index.js';
import type { ReasoningProfile } from '../../../../../shared/types/reasoning.js';
import type { AiRequest } from '../../../ai/contracts.js';
import type { ArtifactReader } from '../../../execution/artifact-port.js';
import {
  mapOpenAiChatRequest,
  OpenAiSerializationError,
} from '../request-mapper.js';

const profile: ReasoningProfile = {
  mode: 'effort',
  options: [{ kind: 'disabled' }, { kind: 'effort', effort: 'high' }],
  defaultSelection: { kind: 'effort', effort: 'high' },
  mandatory: false,
  transportPreset: 'openai-reasoning-object',
  replayPolicy: 'opaque-required',
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
    promptCacheKey: 'agent-cache-key',
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hello' }] }],
    generation: { reasoning: { kind: 'effort', effort: 'high' } },
    ...(extensions && { extensions: { openai: extensions } }),
  };
}

describe('OpenAI request mapper', () => {
  it('serializes the exact compiled upstream model and its configured reasoning protocol', async () => {
    const mapped = await mapOpenAiChatRequest(request({ vendor_flag: true }), 'wire-model-selected-by-user', {
      maxTokensField: 'max_completion_tokens',
      assistantReasoningReplay: 'omit',
      reasoningProfile: profile,
    });

    expect(mapped).toMatchObject({
      model: 'wire-model-selected-by-user',
      prompt_cache_key: 'agent-cache-key',
      vendor_flag: true,
      reasoning: { effort: 'high' },
    });
  });

  it('preserves the canonical object and branch constraints on the wire', async () => {
    const mapped = await mapOpenAiChatRequest(
      {
        ...request(),
        tools: [{ name: 'flow', description: 'Manage flows', inputSchema: actionSchema }],
      },
      'wire-model-selected-by-user',
      {
        maxTokensField: 'max_completion_tokens',
        assistantReasoningReplay: 'omit',
        reasoningProfile: profile,
      },
    );

    expect(mapped.tools).toEqual([{
      type: 'function',
      function: {
        name: 'flow',
        description: 'Manage flows',
        parameters: actionSchema,
      },
    }]);
  });

  it('projects every canonical generation option without changing its value', async () => {
    const mapped = await mapOpenAiChatRequest(
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
        maxTokensField: 'max_completion_tokens',
        assistantReasoningReplay: 'omit',
        reasoningProfile: profile,
      },
    );

    expect(mapped).toMatchObject({
      max_completion_tokens: 32_000,
      temperature: 0.3,
      top_p: 0.85,
      stop: ['DONE'],
      reasoning: { effort: 'high' },
    });
  });

  it('preserves consecutive user messages as separate OpenAI messages', async () => {
    const mapped = await mapOpenAiChatRequest(
      {
        ...request(),
        messages: [
          { role: 'user', content: [{ kind: 'text', text: '用户输入' }] },
          { role: 'user', content: [{ kind: 'text', text: '后台通知' }] },
        ],
      },
      'wire-model-selected-by-user',
      {
        maxTokensField: 'max_completion_tokens',
        assistantReasoningReplay: 'omit',
        reasoningProfile: profile,
      },
    );

    expect(mapped.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '用户输入' }] },
      { role: 'user', content: [{ type: 'text', text: '后台通知' }] },
    ]);
  });

  it('splits screenshot tool results into a text tool message followed by a user image message', async () => {
    const screenshot = Buffer.from('screenshot-pixels');
    const artifacts: ArtifactReader = {
      async read(ref) {
        expect(ref).toEqual({ artifactId: 'screenshot-artifact' });
        return { bytes: screenshot, mimeType: 'image/png' };
      },
    };
    const mapped = await mapOpenAiChatRequest(
      {
        model: { providerId: 'configured-provider', modelId: 'configured-binding' },
        messages: [
          {
            role: 'assistant',
            content: [{ kind: 'tool_call', callId: 'call_screenshot', name: 'read', arguments: '{}' }],
          },
          {
            role: 'tool',
            toolCallId: 'call_screenshot',
            content: [
              { kind: 'text', text: 'Screenshot captured.' },
              { kind: 'image', artifact: { artifactId: 'screenshot-artifact' } },
            ],
          },
        ],
      },
      'wire-model-selected-by-user',
      {
        maxTokensField: 'max_completion_tokens',
        assistantReasoningReplay: 'omit',
      },
      artifacts,
    );

    expect(mapped.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_screenshot',
          type: 'function',
          function: { name: 'read', arguments: '{}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_screenshot',
        content: 'Screenshot captured.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[工具返回的截图]' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}` },
          },
        ],
      },
    ]);
  });

  it('replays compatible chat reasoning through reasoning_content only when explicitly configured', async () => {
    const mapped = await mapOpenAiChatRequest(
      {
        model: { providerId: 'configured-provider', modelId: 'configured-binding' },
        messages: [{
          role: 'assistant',
          content: [
            { kind: 'reasoning', item: { protocol: 'openai-chat', text: 'opaque-compatible-state' } },
            { kind: 'tool_call', callId: 'call_1', name: 'lookup', arguments: '{}' },
          ],
        }],
      },
      'wire-model-selected-by-user',
      {
        maxTokensField: 'max_completion_tokens',
        assistantReasoningReplay: 'reasoning_content',
      },
    );

    expect(mapped.messages).toEqual([{
      role: 'assistant',
      content: null,
      reasoning_content: 'opaque-compatible-state',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{}' },
      }],
    }]);
  });

  it('does not let an extension replace a controlled reasoning field', async () => {
    await expect(mapOpenAiChatRequest(
      request({ reasoning: { effort: 'low' } }),
      'wire-model-selected-by-user',
      {
        maxTokensField: 'max_completion_tokens',
        assistantReasoningReplay: 'omit',
        reasoningProfile: profile,
      },
    )).rejects.toMatchObject<Partial<OpenAiSerializationError>>({
      code: 'OPENAI_EXTENSION_RESERVED',
    });
  });

  it('keeps prompt_cache_key owned by the driver', async () => {
    await expect(mapOpenAiChatRequest(
      request({ prompt_cache_key: 'extension-key' }),
      'wire-model-selected-by-user',
      {
        maxTokensField: 'max_completion_tokens',
        assistantReasoningReplay: 'omit',
        reasoningProfile: profile,
      },
    )).rejects.toMatchObject<Partial<OpenAiSerializationError>>({
      code: 'OPENAI_EXTENSION_RESERVED',
    });
  });
});
