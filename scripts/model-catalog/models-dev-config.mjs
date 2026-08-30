export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** models.dev provider id -> Piskie ProviderType. */
export const MODELS_DEV_PROVIDER_MAP = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'gemini',
  deepseek: 'deepseek',
  zhipuai: 'zhipu',
  minimax: 'minimax',
  'alibaba-coding-plan': 'aliyun',
  'amazon-bedrock': 'bedrock',
  'fireworks-ai': 'fireworks',
  groq: 'groq',
  togetherai: 'together',
  openrouter: 'openrouter',
};

export const PISKIE_TO_MODELS_DEV_PROVIDER = Object.fromEntries(
  Object.entries(MODELS_DEV_PROVIDER_MAP).map(([source, provider]) => [provider, source]),
);
