export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export type ReasoningSelection =
  | { kind: 'provider-default' }
  | { kind: 'disabled' }
  | { kind: 'enabled' }
  | { kind: 'effort'; effort: ReasoningEffort }
  | { kind: 'budget'; tokens: number };

export type ReasoningTransportPreset =
  | 'none'
  | 'openai-effort'
  | 'openai-reasoning-object'
  | 'anthropic-adaptive-effort'
  | 'anthropic-budget'
  | 'gemini-effort'
  | 'deepseek-thinking'
  | 'dashscope-enable-thinking'
  | 'minimax-thinking'
  | 'volcengine-reasoning'
  | 'together-reasoning'
  | 'fireworks-reasoning'
  | 'openrouter-reasoning'
  | 'ollama-think';

export interface ReasoningProfile {
  mode: 'none' | 'fixed' | 'toggle' | 'effort' | 'budget' | 'effort-or-budget';
  options: ReasoningSelection[];
  defaultSelection: ReasoningSelection;
  mandatory: boolean;
  transportPreset: ReasoningTransportPreset;
  replayPolicy: 'none' | 'visible' | 'opaque-required';
  minBudgetTokens?: number;
  maxBudgetTokens?: number;
}
