import { describe, expect, it } from 'vitest';
import type { AiRequest } from '../../../ai/contracts.js';
import type { ArtifactReader } from '../../../execution/artifact-port.js';
import { OpenAiSerializationError, type OpenAiModelOptions } from '../request-mapper.js';
import { mapOpenAiResponsesRequest } from '../responses-request-mapper.js';

const options = {
  wireApi: 'responses' as const,
  maxTokensField: 'max_completion_tokens' as const,
  assistantReasoningReplay: 'omit' as const,
};

function optionsWithReasoning(
  transportPreset: 'openai-effort' | 'openai-reasoning-object',
): OpenAiModelOptions {
  return {
    ...options,
    reasoningProfile: {
      mode: 'effort',
      options: [
        { kind: 'disabled' },
        { kind: 'effort', effort: 'max' },
      ],
      defaultSelection: { kind: 'effort', effort: 'max' },
      mandatory: false,
      transportPreset,
      replayPolicy: 'opaque-required',
    },
  };
}

describe('OpenAI Responses request mapper', () => {
  it('maps internal system guidance to the recommended developer role', async () => {
    const request: AiRequest = {
      model: { providerId: 'provider', modelId: 'model' },
      promptCacheKey: 'agent-cache-key',
      messages: [
        { role: 'system', content: [{ kind: 'text', text: 'Follow the application rules.' }] },
        { role: 'user', content: [{ kind: 'text', text: 'Hello' }] },
      ],
    };

    const mapped = await mapOpenAiResponsesRequest(request, 'wire-model', options);

    expect(mapped.prompt_cache_key).toBe('agent-cache-key');
    expect(mapped.input).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Follow the application rules.' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }],
      },
    ]);
  });

  it.each(['openai-effort', 'openai-reasoning-object'] as const)(
    'opts in to an automatic reasoning summary for %s',
    async (transportPreset) => {
      const request: AiRequest = {
        model: { providerId: 'provider', modelId: 'model' },
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'Think this through.' }] }],
        generation: { reasoning: { kind: 'effort', effort: 'max' } },
      };

      const mapped = await mapOpenAiResponsesRequest(
        request,
        'wire-model',
        optionsWithReasoning(transportPreset),
      );

      expect(mapped.reasoning).toEqual({ effort: 'max', summary: 'auto' });
    },
  );

  it.each(['openai-effort', 'openai-reasoning-object'] as const)(
    'does not request a reasoning summary when %s reasoning is disabled',
    async (transportPreset) => {
      const request: AiRequest = {
        model: { providerId: 'provider', modelId: 'model' },
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'Answer directly.' }] }],
        generation: { reasoning: { kind: 'disabled' } },
      };

      const mapped = await mapOpenAiResponsesRequest(
        request,
        'wire-model',
        optionsWithReasoning(transportPreset),
      );

      expect(mapped.reasoning).toEqual({ effort: 'none' });
    },
  );

  it('preserves encrypted reasoning and function items in wire order with screenshot output', async () => {
    const screenshot = Buffer.from('responses-screenshot');
    const artifacts: ArtifactReader = {
      async read(ref) {
        expect(ref).toEqual({ artifactId: 'screenshot-artifact' });
        return { bytes: screenshot, mimeType: 'image/png' };
      },
    };
    const request: AiRequest = {
      model: { providerId: 'provider', modelId: 'model' },
      messages: [
        { role: 'user', content: [{ kind: 'text', text: 'inspect this' }] },
        {
          role: 'assistant',
          content: [
            {
              kind: 'reasoning',
              item: {
                protocol: 'openai-responses',
                id: 'rs_1',
                summary: [{ type: 'summary_text', text: 'Need a screenshot.' }],
                encryptedContent: 'encrypted-state',
                status: 'completed',
              },
            },
            {
              kind: 'tool_call',
              callId: 'call_1',
              providerItemId: 'fc_1',
              name: 'take_screenshot',
              arguments: '{"fullPage":true}',
              status: 'completed',
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call_1',
          content: [
            { kind: 'text', text: 'Screenshot captured.' },
            { kind: 'image', artifact: { artifactId: 'screenshot-artifact' } },
          ],
        },
      ],
      tools: [{
        name: 'take_screenshot',
        description: 'Take a screenshot.',
        inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } } },
      }],
      generation: { maxOutputTokens: 4_096 },
    };

    const mapped = await mapOpenAiResponsesRequest(request, 'wire-model', options, artifacts);

    expect(mapped).toMatchObject({
      model: 'wire-model',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 4_096,
      tools: [{
        type: 'function',
        name: 'take_screenshot',
        description: 'Take a screenshot.',
        parameters: request.tools![0]!.inputSchema,
        strict: false,
      }],
    });
    expect(mapped.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'inspect this' }],
      },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Need a screenshot.' }],
        encrypted_content: 'encrypted-state',
        status: 'completed',
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'take_screenshot',
        arguments: '{"fullPage":true}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'Screenshot captured.' },
          {
            type: 'input_image',
            detail: 'auto',
            image_url: `data:image/png;base64,${screenshot.toString('base64')}`,
          },
        ],
      },
    ]);
  });

  it('rejects a reasoning item whose replay id was lost', async () => {
    const request: AiRequest = {
      model: { providerId: 'provider', modelId: 'model' },
      messages: [{
        role: 'assistant',
        content: [{
          kind: 'reasoning',
          item: {
            protocol: 'openai-responses',
            summary: [],
            encryptedContent: 'encrypted-state',
          },
        }],
      }],
    };

    await expect(mapOpenAiResponsesRequest(request, 'wire-model', options)).rejects.toMatchObject<
      Partial<OpenAiSerializationError>
    >({ code: 'OPENAI_RESPONSES_REASONING_ID_MISSING' });
  });

  it('keeps prompt_cache_key owned by the driver', async () => {
    const request: AiRequest = {
      model: { providerId: 'provider', modelId: 'model' },
      promptCacheKey: 'agent-cache-key',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello' }] }],
      extensions: { openai: { prompt_cache_key: 'extension-key' } },
    };

    await expect(mapOpenAiResponsesRequest(request, 'wire-model', options)).rejects.toMatchObject<
      Partial<OpenAiSerializationError>
    >({ code: 'OPENAI_EXTENSION_RESERVED' });
  });
});
