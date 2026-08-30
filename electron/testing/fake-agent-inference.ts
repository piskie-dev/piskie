import type {
  AgentInferencePort,
  AgentInferenceRequest,
  AgentInferenceOptions,
} from '../inference/application/agent-inference-port.js';
import type { AIResponse } from '../../shared/types/index.js';
import type { ReasoningSelection } from '../../shared/types/reasoning.js';

const DEFAULT_RESPONSE: AIResponse = {
  content: [{ type: 'text', text: 'ok' }],
  requestInfo: {
    version: 1,
    requestId: 'fake-request',
    runId: 'fake-run',
    model: 'fake/model',
    stopReason: 'end_turn',
    latencyMs: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
  },
};

export function fakeAgentInference(overrides: Partial<AgentInferencePort> = {}): AgentInferencePort {
  return {
    invoke: async (_request: AgentInferenceRequest, options: AgentInferenceOptions) => ({
      ...DEFAULT_RESPONSE,
      requestInfo: { ...DEFAULT_RESPONSE.requestInfo, requestId: options.requestId },
    }),
    resolveReasoning: (_target, override?: ReasoningSelection) => ({
      selection: override ?? { kind: 'provider-default' },
      source: override ? 'agent' : 'provider-default',
      nativeParameters: {},
    }),
    assertTarget: () => undefined,
    contextWindow: () => 200_000,
    // 默认「无此能力」：与 openai driver 一致，准入据此直接发出去让服务端判
    countInputTokens: async () => undefined,
    ...overrides,
  };
}
