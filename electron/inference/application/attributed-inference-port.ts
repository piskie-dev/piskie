import type { UsageAttribution } from '../../../shared/types/model-usage.js';
import type { AgentInferencePort } from './agent-inference-port.js';

/** All calls made by a runtime, including its compactor and modules, share its identity. */
export function attributedInferencePort(port: AgentInferencePort, attribution: () => UsageAttribution): AgentInferencePort {
  return {
    invoke: (request, options) => {
      let identity: UsageAttribution | undefined;
      try { identity = attribution(); } catch { /* Missing report metadata cannot stop execution. */ }
      return port.invoke(request, { ...options, usage: { purpose: 'inference', ...identity, ...options.usage } });
    },
    resolveReasoning: (target, override) => port.resolveReasoning(target, override),
    assertTarget: (target) => port.assertTarget(target),
    contextWindow: (target) => port.contextWindow(target),
    countInputTokens: (request, signal) => port.countInputTokens(request, signal),
  };
}
