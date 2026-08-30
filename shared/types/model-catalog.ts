export type CatalogProviderId =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'deepseek'
  | 'zhipu'
  | 'minimax'
  | 'aliyun'
  | 'volcengine'
  | 'baidu'
  | 'fireworks'
  | 'groq'
  | 'together'
  | 'openrouter'
  | 'ollama'
  | 'vllm'
  | 'llama-cpp'
  | 'bedrock'
  | 'anthropic-compatible'
  | 'openai-compatible';

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';
export type ModelLifecycle = 'preview' | 'active' | 'deprecated' | 'retired';
export type ModelTag = 'high-performance' | 'cost-effective' | 'balanced';

export interface ModelCapabilityProfile {
  toolUse: CapabilityState;
  vision: CapabilityState;
  streaming: CapabilityState;
}

export interface CatalogProvenance {
  sourceUrls: string[];
  verifiedAt: string;
  catalogVersion: string;
}

export interface ModelPricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
}
