import { GatewayCallError } from '../execution/call-error.js';
import type { ModelTarget } from '../execution/contracts.js';
import type {
  AiAssistantPart,
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

interface AttemptResultAccumulator {
  text: string;
  reasoning: string;
  reasoningSignature?: string;
  usage: AiUsage;
  stopReason?: AiResult['stopReason'];
  toolCalls: Map<string, MutableToolCall>;
  content: Array<AiAssistantPart | MutableToolCall>;
  reasoningItems: AiReasoningItem[];
}

export async function collectAiResult(
  events: AsyncIterable<AiEvent>,
  expectedModel: ModelTarget,
  traceId: string,
): Promise<AiResult> {
  let runId = '';
  let configRevision = 0;
  let attemptResult = createAttemptResultAccumulator();

  for await (const event of events) {
    runId = event.runId;
    switch (event.kind) {
      case 'response.started':
        configRevision = event.configRevision;
        break;
      case 'text.delta':
        attemptResult.text += event.text;
        appendText(attemptResult.content, event.text);
        break;
      case 'reasoning.delta':
        attemptResult.reasoning += event.text;
        break;
      case 'reasoning.signature':
        attemptResult.reasoningSignature = event.signature;
        break;
      case 'reasoning.item':
        attemptResult.reasoningItems.push(event.item);
        attemptResult.content.push({ kind: 'reasoning', item: event.item });
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
        attemptResult.toolCalls.set(event.callId, call);
        attemptResult.content.push(call);
        break;
      }
      case 'tool.arguments.delta': {
        const call = attemptResult.toolCalls.get(event.callId);
        if (call) call.arguments += event.delta;
        break;
      }
      case 'tool.completed': {
        const call = attemptResult.toolCalls.get(event.callId);
        if (call?.status === 'in_progress') call.status = 'completed';
        break;
      }
      case 'usage.updated':
        attemptResult.usage = mergeUsage(attemptResult.usage, event.usage);
        break;
      case 'response.completed':
        attemptResult.stopReason = event.stopReason;
        break;
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
          attempt: event.attempt,
          traceId,
          message: event.reason ?? 'AI request cancelled',
          localCode: 'AI_REQUEST_CANCELLED',
        });
      case 'response.retrying':
        attemptResult = createAttemptResultAccumulator();
        break;
    }
  }

  if (!attemptResult.stopReason) {
    throw new GatewayCallError({
      source: 'local',
      gateway: 'ai',
      providerId: expectedModel.providerId,
      modelId: expectedModel.modelId,
      driverId: 'inference-core',
      stage: 'collect',
      attempt: 0,
      traceId,
      message: 'AI event stream ended without a completion event',
      localCode: 'AI_RESULT_INCOMPLETE',
    });
  }

  if (attemptResult.reasoningItems.length === 0 && attemptResult.reasoning) {
    const textualItem: AiReasoningItem = attemptResult.reasoningSignature
      ? {
          protocol: 'anthropic-thinking',
          text: attemptResult.reasoning,
          signature: attemptResult.reasoningSignature,
        }
      : { protocol: 'openai-chat', text: attemptResult.reasoning };
    attemptResult.reasoningItems.push(textualItem);
    attemptResult.content.unshift({ kind: 'reasoning', item: textualItem });
  }

  const finalizedToolCalls = [...attemptResult.toolCalls.values()].map(finalizeToolCall);
  return {
    runId,
    model: expectedModel,
    configRevision,
    text: attemptResult.text,
    reasoning: attemptResult.reasoning,
    ...(attemptResult.reasoningSignature && {
      reasoningSignature: attemptResult.reasoningSignature,
    }),
    content: attemptResult.content.map(finalizeAssistantPart),
    reasoningItems: attemptResult.reasoningItems,
    toolCalls: finalizedToolCalls,
    usage: attemptResult.usage,
    stopReason: attemptResult.stopReason,
  };
}

function createAttemptResultAccumulator(): AttemptResultAccumulator {
  return {
    text: '',
    reasoning: '',
    usage: {},
    toolCalls: new Map(),
    content: [],
    reasoningItems: [],
  };
}

function mergeUsage(current: AiUsage, next: AiUsage): AiUsage {
  return { ...current, ...next };
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
