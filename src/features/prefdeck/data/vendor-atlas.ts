/**
 * 供应商图鉴（双玻璃设置台 · 预设事实表重写）。
 *
 * AI / 生图两个网关的内置供应商预设:品牌、驱动、默认端点、鉴权形态、
 * 目录家族与思考协议缺省。事实值(端点/密钥占位/端点指纹)与推理后端一致,
 * 组织为对象字面量图鉴 + 查询函数。纯数据/纯函数,无 React 依赖。
 */

import type {
  InferenceProviderInstance,
  PlainInferenceAuth,
} from '../../../../shared/types/inference';
import type { ReasoningTransportPreset } from '../../../../shared/types/reasoning';

export type GatewayKind = 'ai' | 'image';

/** 图鉴分翼(展示分组) */
export type VendorWing = 'flagship' | 'openhub' | 'onprem' | 'diy';

export type VendorDriver =
  | 'openai'
  | 'anthropic-messages'
  | 'comfyui-workflow'
  | 'openrouter-image'
  | 'gemini-image'
  | 'dashscope-image'
  | 'baidu-image';

export interface VendorSpec {
  readonly key: string;
  readonly title: string;
  /** 品牌图标 key(@lobehub/icons 映射;diy-plug/diy-socket 为自绘端点图标;未知回落首二字) */
  readonly brand: string;
  readonly wing: VendorWing;
  readonly driver: VendorDriver;
  readonly baseUrl: string;
  readonly keyHint: string;
  readonly keyRequired: boolean;
  readonly authKind: PlainInferenceAuth['kind'];
  /** 端点指纹:baseUrl 命中即认定为该预设 */
  readonly hostHints?: readonly string[];
  /** 模型目录家族(生图预设与 id 不同名时显式给出) */
  readonly family?: string;
  /** api_key 鉴权的自定义 header(缺省 x-api-key) */
  readonly keyHeader?: string;
}

export const WING_ORDER: readonly VendorWing[] = ['flagship', 'openhub', 'onprem', 'diy'];

const AI_ATLAS: readonly VendorSpec[] = [
  { key: 'anthropic', title: 'Anthropic', brand: 'anthropic', wing: 'flagship', driver: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', keyHint: 'sk-ant-api...', keyRequired: true, authKind: 'api_key', hostHints: ['api.anthropic.com'] },
  { key: 'openai', title: 'OpenAI', brand: 'openai', wing: 'flagship', driver: 'openai', baseUrl: 'https://api.openai.com/v1', keyHint: 'sk-...', keyRequired: true, authKind: 'bearer', hostHints: ['api.openai.com'] },
  { key: 'gemini', title: 'Google Gemini', brand: 'gemini', wing: 'flagship', driver: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyHint: 'AI...', keyRequired: true, authKind: 'bearer', hostHints: ['generativelanguage.googleapis.com'] },
  { key: 'deepseek', title: 'DeepSeek', brand: 'deepseek', wing: 'flagship', driver: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic', keyHint: 'sk-...', keyRequired: true, authKind: 'api_key', hostHints: ['api.deepseek.com'] },
  { key: 'zhipu', title: '智谱 AI', brand: 'zhipu', wing: 'flagship', driver: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic', keyHint: 'API Key', keyRequired: true, authKind: 'api_key', hostHints: ['open.bigmodel.cn'] },
  { key: 'minimax', title: 'MiniMax', brand: 'minimax', wing: 'flagship', driver: 'anthropic-messages', baseUrl: 'https://api.minimax.io/anthropic', keyHint: 'API Key', keyRequired: true, authKind: 'api_key', hostHints: ['api.minimax.io'] },
  { key: 'aliyun', title: '阿里云百炼', brand: 'aliyun', wing: 'flagship', driver: 'anthropic-messages', baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', keyHint: 'sk-...', keyRequired: true, authKind: 'api_key', hostHints: ['dashscope.aliyuncs.com'] },
  { key: 'volcengine', title: '火山方舟', brand: 'volcengine', wing: 'flagship', driver: 'anthropic-messages', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', keyHint: 'API Key', keyRequired: true, authKind: 'api_key', hostHints: ['volces.com'] },
  { key: 'baidu', title: '百度千帆', brand: 'baidu', wing: 'flagship', driver: 'anthropic-messages', baseUrl: 'https://qianfan.baidubce.com/v2/anthropic', keyHint: 'API Key', keyRequired: true, authKind: 'api_key', hostHints: ['baidubce.com'] },
  { key: 'openrouter', title: 'OpenRouter', brand: 'openrouter', wing: 'openhub', driver: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyHint: 'sk-or-...', keyRequired: true, authKind: 'bearer', hostHints: ['openrouter.ai'] },
  { key: 'fireworks', title: 'Fireworks AI', brand: 'fireworks', wing: 'openhub', driver: 'anthropic-messages', baseUrl: 'https://api.fireworks.ai/inference', keyHint: 'API Key', keyRequired: true, authKind: 'api_key', hostHints: ['fireworks.ai'] },
  { key: 'groq', title: 'Groq', brand: 'groq', wing: 'openhub', driver: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyHint: 'gsk_...', keyRequired: true, authKind: 'bearer', hostHints: ['api.groq.com'] },
  { key: 'together', title: 'Together AI', brand: 'together', wing: 'openhub', driver: 'openai', baseUrl: 'https://api.together.xyz/v1', keyHint: 'API Key', keyRequired: true, authKind: 'bearer', hostHints: ['api.together.xyz'] },
  { key: 'ollama', title: 'Ollama', brand: 'ollama', wing: 'onprem', driver: 'openai', baseUrl: 'http://localhost:11434/v1', keyHint: '', keyRequired: false, authKind: 'none', hostHints: ['localhost:11434', '127.0.0.1:11434'] },
  { key: 'vllm', title: 'vLLM', brand: 'vllm', wing: 'onprem', driver: 'openai', baseUrl: 'http://localhost:8000/v1', keyHint: '', keyRequired: false, authKind: 'none', hostHints: ['localhost:8000', '127.0.0.1:8000'] },
  { key: 'llama-cpp', title: 'llama.cpp', brand: 'llamacpp', wing: 'onprem', driver: 'openai', baseUrl: 'http://localhost:8080/v1', keyHint: '', keyRequired: false, authKind: 'none', hostHints: ['localhost:8080', '127.0.0.1:8080'] },
  { key: 'anthropic-compatible', title: '自定义 (Anthropic 兼容)', brand: 'diy-plug', wing: 'diy', driver: 'anthropic-messages', baseUrl: '', keyHint: 'API Key', keyRequired: false, authKind: 'api_key' },
  { key: 'openai-compatible', title: '自定义 (OpenAI 兼容)', brand: 'diy-socket', wing: 'diy', driver: 'openai', baseUrl: '', keyHint: 'API Key', keyRequired: false, authKind: 'bearer' },
];

const IMAGE_ATLAS: readonly VendorSpec[] = [
  { key: 'openai-image', title: 'OpenAI', brand: 'openai', wing: 'flagship', driver: 'openai', baseUrl: 'https://api.openai.com/v1', keyHint: 'sk-...', keyRequired: true, authKind: 'bearer', hostHints: ['api.openai.com'], family: 'openai' },
  { key: 'gemini-image', title: 'Google Gemini', brand: 'gemini', wing: 'flagship', driver: 'gemini-image', baseUrl: 'https://generativelanguage.googleapis.com', keyHint: 'AI...', keyRequired: true, authKind: 'api_key', hostHints: ['generativelanguage.googleapis.com'], family: 'gemini', keyHeader: 'x-goog-api-key' },
  { key: 'aliyun-image', title: '阿里云通义万象', brand: 'aliyun', wing: 'flagship', driver: 'dashscope-image', baseUrl: 'https://dashscope.aliyuncs.com', keyHint: 'sk-...', keyRequired: true, authKind: 'bearer', hostHints: ['dashscope.aliyuncs.com'], family: 'aliyun' },
  { key: 'baidu-image', title: '百度千帆', brand: 'baidu', wing: 'flagship', driver: 'baidu-image', baseUrl: 'https://qianfan.baidubce.com', keyHint: 'bce-v3/...', keyRequired: true, authKind: 'bearer', hostHints: ['qianfan.baidubce.com'], family: 'baidu' },
  { key: 'zhipu-image', title: '智谱 CogView', brand: 'zhipu', wing: 'flagship', driver: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyHint: 'API Key', keyRequired: true, authKind: 'bearer', hostHints: ['open.bigmodel.cn'], family: 'zhipu' },
  { key: 'openrouter-image', title: 'OpenRouter', brand: 'openrouter', wing: 'openhub', driver: 'openrouter-image', baseUrl: 'https://openrouter.ai/api/v1', keyHint: 'sk-or-...', keyRequired: true, authKind: 'bearer', hostHints: ['openrouter.ai'], family: 'openrouter' },
  { key: 'comfyui', title: 'ComfyUI', brand: 'comfyui', wing: 'onprem', driver: 'comfyui-workflow', baseUrl: 'http://127.0.0.1:8188', keyHint: '', keyRequired: false, authKind: 'none', hostHints: ['127.0.0.1:8188', 'localhost:8188'] },
  { key: 'openai-image-compatible', title: 'OpenAI 兼容', brand: 'diy-socket', wing: 'diy', driver: 'openai', baseUrl: '', keyHint: 'API Key', keyRequired: false, authKind: 'bearer' },
];

export function vendorsFor(gateway: GatewayKind): readonly VendorSpec[] {
  return gateway === 'ai' ? AI_ATLAS : IMAGE_ATLAS;
}

const VENDOR_LOCALE_KEYS: Readonly<Record<string, string>> = {
  'llama-cpp': 'llamaCpp',
  'anthropic-compatible': 'anthropicCompatible',
  'openai-compatible': 'openaiCompatible',
  'openai-image': 'openaiImage',
  'gemini-image': 'geminiImage',
  'aliyun-image': 'aliyunImage',
  'baidu-image': 'baiduImage',
  'zhipu-image': 'zhipuImage',
  'openrouter-image': 'openrouterImage',
  'openai-image-compatible': 'openaiImageCompatible',
};

export function vendorLocaleKey(spec: VendorSpec, field: 'title' | 'brief'): string {
  return `settings.vendorCatalog.${VENDOR_LOCALE_KEYS[spec.key] ?? spec.key}.${field}`;
}

/** 预设 key → 思考参数传输协议缺省(仅 AI 网关有意义) */
const TRANSPORT_DEFAULTS: Readonly<Record<string, ReasoningTransportPreset>> = {
  anthropic: 'anthropic-adaptive-effort',
  openai: 'openai-effort',
  gemini: 'gemini-effort',
  deepseek: 'deepseek-thinking',
  zhipu: 'deepseek-thinking',
  minimax: 'minimax-thinking',
  aliyun: 'dashscope-enable-thinking',
  volcengine: 'volcengine-reasoning',
  baidu: 'none',
  openrouter: 'openrouter-reasoning',
  fireworks: 'fireworks-reasoning',
  groq: 'openai-effort',
  together: 'together-reasoning',
  ollama: 'ollama-think',
  vllm: 'none',
  'llama-cpp': 'none',
  'anthropic-compatible': 'anthropic-adaptive-effort',
  'openai-compatible': 'openai-effort',
};

export function defaultTransportOf(spec: VendorSpec): ReasoningTransportPreset {
  return TRANSPORT_DEFAULTS[spec.key] ?? 'none';
}

/** 思考协议仅自定义预设允许改写(内置端点协议已知) */
export function transportEditable(spec: VendorSpec): boolean {
  return spec.wing === 'diy';
}

/** 目录家族(未显式给出时 = 预设 key) */
export function familyOf(spec: VendorSpec): string {
  return spec.family ?? spec.key;
}

type VendorShape = Pick<InferenceProviderInstance, 'displayName' | 'driver'> & {
  connection: Pick<InferenceProviderInstance['connection'], 'baseUrl'>;
};

/**
 * 认定既有 Provider 属于哪个预设:同驱动候选内
 * ①端点指纹命中 ②显示名包含预设名 ③回落自定义/首个候选。
 */
export function matchVendor(provider: VendorShape, gateway: GatewayKind): VendorSpec {
  const peers = vendorsFor(gateway).filter((spec) => spec.driver === provider.driver);
  const endpoint = provider.connection.baseUrl.toLocaleLowerCase();
  const byEndpoint = peers.find((spec) => spec.hostHints?.some((hint) => endpoint.includes(hint)));
  if (byEndpoint) return byEndpoint;

  const name = provider.displayName.toLocaleLowerCase();
  const byName = peers.find((spec) => spec.wing !== 'diy'
    && (name.includes(spec.key.toLocaleLowerCase()) || name.includes(spec.title.toLocaleLowerCase())));
  if (byName) return byName;

  return peers.find((spec) => spec.wing === 'diy') ?? peers[0] ?? vendorsFor(gateway).at(-1)!;
}

/** 按预设的鉴权形态组装 auth */
export function forgeAuth(spec: VendorSpec, apiKey: string): PlainInferenceAuth {
  switch (spec.authKind) {
    case 'none':
      return { kind: 'none' };
    case 'api_key':
      return { kind: 'api_key', header: spec.keyHeader ?? 'x-api-key', value: apiKey };
    case 'basic':
      return { kind: 'basic', username: '', password: apiKey };
    case 'aws':
      return { kind: 'aws', accessKeyId: '', secretAccessKey: apiKey, region: 'us-east-1' };
    default:
      return { kind: 'bearer', value: apiKey };
  }
}

/** 从 auth 取出可编辑的密钥位 */
export function peekKey(auth: PlainInferenceAuth): string {
  switch (auth.kind) {
    case 'bearer':
    case 'api_key':
      return auth.value;
    case 'basic':
      return auth.password;
    case 'aws':
      return auth.secretAccessKey;
    default:
      return '';
  }
}

/** 只改密钥位,保留 auth 其余字段 */
export function pokeKey(auth: PlainInferenceAuth, value: string): PlainInferenceAuth {
  switch (auth.kind) {
    case 'bearer':
      return { kind: 'bearer', value };
    case 'api_key':
      return { kind: 'api_key', header: auth.header, value };
    case 'basic':
      return { kind: 'basic', username: auth.username, password: value };
    case 'aws':
      return {
        kind: 'aws',
        accessKeyId: auth.accessKeyId,
        secretAccessKey: value,
        region: auth.region,
        ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {}),
      };
    default:
      return { kind: 'none' };
  }
}

/** 建议不重名的显示名:被占用时追加序号 */
export function coinDisplayName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) return base;
  let ordinal = 2;
  while (used.has(`${base} ${ordinal}`.toLocaleLowerCase())) ordinal += 1;
  return `${base} ${ordinal}`;
}
