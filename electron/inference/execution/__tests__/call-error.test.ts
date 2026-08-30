import { describe, expect, it } from 'vitest';
import { AIErrorType } from '../../../../shared/constants/index.js';
import { classifyGatewayCallError, GatewayCallError } from '../call-error.js';

describe('GatewayCallError', () => {
  it('serializes upstream fields without replacing the provider body', () => {
    const error = new GatewayCallError({
      source: 'provider',
      gateway: 'image',
      providerId: 'local-comfy',
      modelId: 'workflow',
      driverId: 'comfyui-workflow',
      stage: 'submit',
      attempt: 1,
      traceId: 'trace-9',
      message: 'Prompt validation failed',
      upstream: {
        status: 400,
        code: 'prompt_outputs_failed_validation',
        type: 'comfyui.prompt_error',
        message: 'Prompt validation failed',
        requestId: 'prompt-123',
        body: { node_errors: { '6': { errors: ['missing text'] } } },
      },
    });

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      source: 'provider',
      gateway: 'image',
      providerId: 'local-comfy',
      modelId: 'workflow',
      driverId: 'comfyui-workflow',
      stage: 'submit',
      attempt: 1,
      traceId: 'trace-9',
      message: 'Prompt validation failed',
      upstream: {
        status: 400,
        code: 'prompt_outputs_failed_validation',
        type: 'comfyui.prompt_error',
        message: 'Prompt validation failed',
        requestId: 'prompt-123',
        body: { node_errors: { '6': { errors: ['missing text'] } } },
      },
    });
  });

  it('classifies context overflow only from the provider code, never the message', () => {
    const withCode = new GatewayCallError({
      source: 'provider',
      gateway: 'ai',
      providerId: 'provider',
      modelId: 'model',
      driverId: 'openai',
      stage: 'request',
      attempt: 1,
      traceId: 'trace-code',
      message: 'Opaque provider failure',
      upstream: {
        status: 429,
        code: 'context_length_exceeded',
        message: 'Opaque provider failure',
      },
    });
    const messageOnly = new GatewayCallError({
      source: 'provider',
      gateway: 'ai',
      providerId: 'provider',
      modelId: 'model',
      driverId: 'openai',
      stage: 'request',
      attempt: 1,
      traceId: 'trace-message',
      message: 'Your input exceeds the context window of this model.',
      upstream: {
        status: 400,
        code: 'invalid_prompt',
        message: 'Your input exceeds the context window of this model.',
      },
    });

    expect(classifyGatewayCallError(withCode)).toBe(AIErrorType.CONTEXT_OVERFLOW);
    expect(classifyGatewayCallError(messageOnly)).toBe(AIErrorType.API_ERROR);
  });
});
