import { GatewayCallError } from '../execution/call-error.js';
import type { ModelTarget } from '../execution/contracts.js';
import type {
  AiAssistantPart,
  AiAttemptEvent,
  AiEvent,
  AiReasoningItem,
  AiResult,
  AiToolCallResult,
  AiUsage,
} from './contracts.js';

interface MutableToolCall {
  kind: 'tool_call';
  callId: string;
  name: string;
  arguments: string;
  providerItemId?: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
}

interface AttemptResultContext {
  runId: string;
  model: ModelTarget;
  configRevision: number;
  driverId: string;
  attempt: number;
  traceId: string;
}

/** One accumulator per attempt; only a validated result can complete the run. */
export class AiAttemptResultAccumulator {
  private text = '';
  private reasoning = '';
  private reasoningSignature?: string;
  private usage: AiUsage = {};
  private readonly toolCalls = new Map<string, MutableToolCall>();
  private readonly content: Array<AiAssistantPart | MutableToolCall> = [];
  private readonly reasoningItems: AiReasoningItem[] = [];

  add(event: Exclude<AiAttemptEvent, { kind: 'response.completed' }>): void {
    switch (event.kind) {
      case 'text.delta':
        this.text += event.text;
        appendText(this.content, event.text);
        break;
      case 'reasoning.delta':
        this.reasoning += event.text;
        break;
      case 'reasoning.signature':
        this.reasoningSignature = event.signature;
        break;
      case 'reasoning.item':
        this.reasoningItems.push(event.item);
        this.content.push({ kind: 'reasoning', item: event.item });
        break;
      case 'tool.started': {
        const call: MutableToolCall = {
          kind: 'tool_call',
          callId: event.callId,
          name: event.name,
          arguments: '',
          ...(event.providerItemId && { providerItemId: event.providerItemId }),
          ...(event.status && { status: event.status }),
        };
        this.toolCalls.set(event.callId, call);
        this.content.push(call);
        break;
      }
      case 'tool.arguments.delta': {
        const call = this.toolCalls.get(event.callId);
        if (call) call.arguments += event.delta;
        break;
      }
      case 'tool.completed': {
        const call = this.toolCalls.get(event.callId);
        if (call?.status === 'in_progress') call.status = 'completed';
        break;
      }
      case 'usage.updated':
        this.usage = { ...this.usage, ...event.usage };
        break;
    }
  }

  complete(stopReason: AiResult['stopReason'], context: AttemptResultContext): AiResult {
    if (this.reasoningItems.length === 0 && this.reasoning) {
      const textualItem: AiReasoningItem = this.reasoningSignature
        ? {
            protocol: 'anthropic-thinking',
            text: this.reasoning,
            signature: this.reasoningSignature,
          }
        : { protocol: 'openai-chat', text: this.reasoning };
      this.reasoningItems.push(textualItem);
      this.content.unshift({ kind: 'reasoning', item: textualItem });
    }

    const content = this.content.map(finalizeAssistantPart);
    if (!content.some((part) => part.kind !== 'text' || part.text.length > 0)) {
      const message = 'AI returned empty response (no text, reasoning, or tool calls)';
      throw new GatewayCallError({
        source: 'provider',
        gateway: 'ai',
        providerId: context.model.providerId,
        modelId: context.model.modelId,
        driverId: context.driverId,
        stage: 'result',
        attempt: context.attempt,
        traceId: context.traceId,
        message,
        localCode: 'AI_RESULT_EMPTY',
        upstream: { message, stopReason },
      });
    }
    return {
      runId: context.runId,
      model: context.model,
      configRevision: context.configRevision,
      text: this.text,
      reasoning: this.reasoning,
      ...(this.reasoningSignature && { reasoningSignature: this.reasoningSignature }),
      content,
      reasoningItems: this.reasoningItems,
      toolCalls: [...this.toolCalls.values()].map(finalizeToolCall),
      usage: this.usage,
      stopReason,
    };
  }
}

export async function collectAiResult(
  events: AsyncIterable<AiEvent>,
  expectedModel: ModelTarget,
  traceId: string,
): Promise<AiResult> {
  let attempt = 0;
  for await (const event of events) {
    attempt = event.attempt;
    switch (event.kind) {
      case 'response.completed':
        return event.result;
      case 'response.failed':
        throw event.error;
      case 'response.cancelled':
        throw new GatewayCallError({
          source: 'cancelled',
          gateway: 'ai',
          providerId: expectedModel.providerId,
          modelId: expectedModel.modelId,
          driverId: 'inference-core',
          stage: 'run',
          attempt,
          traceId,
          message: event.reason ?? 'AI request cancelled',
          localCode: 'AI_REQUEST_CANCELLED',
        });
    }
  }

  throw new GatewayCallError({
    source: 'local',
    gateway: 'ai',
    providerId: expectedModel.providerId,
    modelId: expectedModel.modelId,
    driverId: 'inference-core',
    stage: 'collect',
    attempt,
    traceId,
    message: 'AI event stream ended without a completion event',
    localCode: 'AI_RESULT_INCOMPLETE',
  });
}

function finalizeToolCall(call: MutableToolCall): AiToolCallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    parsed = undefined;
  }
  return {
    callId: call.callId,
    name: call.name,
    argumentsText: call.arguments,
    ...(parsed !== undefined && { arguments: parsed }),
    ...(call.providerItemId && { providerItemId: call.providerItemId }),
    ...(call.status && { status: call.status }),
  };
}

function appendText(content: Array<AiAssistantPart | MutableToolCall>, delta: string): void {
  const previous = content.at(-1);
  if (previous?.kind === 'text') previous.text += delta;
  else content.push({ kind: 'text', text: delta });
}

function finalizeAssistantPart(part: AiAssistantPart | MutableToolCall): AiAssistantPart {
  if (part.kind !== 'tool_call') return part;
  return {
    kind: 'tool_call',
    callId: part.callId,
    name: part.name,
    arguments: part.arguments,
    ...(part.providerItemId && { providerItemId: part.providerItemId }),
    ...(part.status && { status: part.status }),
  };
}
