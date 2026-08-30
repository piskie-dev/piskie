/**
 * 供应商品牌图标（重写）。
 *
 * `@lobehub/icons` 品牌集按需映射;自定义端点用自绘插头/插座一对线性图标
 * (currentColor,与单色品牌同族);未收录的品牌回落名称首二字。
 * brand key 见 data/vendor-atlas.ts。
 */

import type { FC, ForwardRefExoticComponent, RefAttributes, SVGProps } from 'react';
import AlibabaCloudIcon from '@lobehub/icons/es/AlibabaCloud/components/Color';
import AnthropicIcon from '@lobehub/icons/es/Anthropic/components/Mono';
import BaiduIcon from '@lobehub/icons/es/Baidu/components/Color';
import ComfyUIIcon from '@lobehub/icons/es/ComfyUI/components/Mono';
import DeepSeekIcon from '@lobehub/icons/es/DeepSeek/components/Color';
import FireworksIcon from '@lobehub/icons/es/Fireworks/components/Color';
import GeminiIcon from '@lobehub/icons/es/Gemini/components/Color';
import GroqIcon from '@lobehub/icons/es/Groq/components/Mono';
import MetaIcon from '@lobehub/icons/es/Meta/components/Color';
import MinimaxIcon from '@lobehub/icons/es/Minimax/components/Color';
import OllamaIcon from '@lobehub/icons/es/Ollama/components/Mono';
import OpenAIIcon from '@lobehub/icons/es/OpenAI/components/Mono';
import OpenRouterIcon from '@lobehub/icons/es/OpenRouter/components/Mono';
import TogetherIcon from '@lobehub/icons/es/Together/components/Color';
import VllmIcon from '@lobehub/icons/es/Vllm/components/Color';
import VolcengineIcon from '@lobehub/icons/es/Volcengine/components/Color';
import ZhipuIcon from '@lobehub/icons/es/Zhipu/components/Color';

type BrandSvg = ForwardRefExoticComponent<
  SVGProps<SVGSVGElement> & { size?: string | number } & RefAttributes<SVGSVGElement>
>;

const BRAND_SVGS: Record<string, BrandSvg> = {
  aliyun: AlibabaCloudIcon as unknown as BrandSvg,
  anthropic: AnthropicIcon as unknown as BrandSvg,
  baidu: BaiduIcon as unknown as BrandSvg,
  comfyui: ComfyUIIcon as unknown as BrandSvg,
  deepseek: DeepSeekIcon as unknown as BrandSvg,
  fireworks: FireworksIcon as unknown as BrandSvg,
  gemini: GeminiIcon as unknown as BrandSvg,
  groq: GroqIcon as unknown as BrandSvg,
  llamacpp: MetaIcon as unknown as BrandSvg,
  minimax: MinimaxIcon as unknown as BrandSvg,
  ollama: OllamaIcon as unknown as BrandSvg,
  openai: OpenAIIcon as unknown as BrandSvg,
  openrouter: OpenRouterIcon as unknown as BrandSvg,
  together: TogetherIcon as unknown as BrandSvg,
  vllm: VllmIcon as unknown as BrandSvg,
  volcengine: VolcengineIcon as unknown as BrandSvg,
  zhipu: ZhipuIcon as unknown as BrandSvg,
};

const ENDPOINT_STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const PlugGlyph: FC<{ readonly size: number }> = ({ size }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...ENDPOINT_STROKE} aria-hidden>
    <path d="M9 3.5v4.5" />
    <path d="M15 3.5v4.5" />
    <path d="M7 8h10v2.5a5 5 0 0 1-5 5 5 5 0 0 1-5-5V8z" />
    <path d="M12 15.5v5" />
  </svg>
);

const SocketGlyph: FC<{ readonly size: number }> = ({ size }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...ENDPOINT_STROKE} aria-hidden>
    <rect x="3.5" y="3.5" width="17" height="17" rx="5.5" />
    <path d="M9.5 9.5v3.2" />
    <path d="M14.5 9.5v3.2" />
    <path d="M9.5 16.5h5" />
  </svg>
);

const ENDPOINT_GLYPHS: Record<string, FC<{ readonly size: number }>> = {
  'diy-plug': PlugGlyph,
  'diy-socket': SocketGlyph,
};

export const BrandMark: FC<{
  readonly brand: string;
  readonly title: string;
  readonly size?: number;
}> = ({ brand, title, size = 20 }) => {
  const Glyph = ENDPOINT_GLYPHS[brand];
  if (Glyph) return <Glyph size={size} />;
  const Svg = BRAND_SVGS[brand];
  if (Svg) return <Svg size={size} />;
  return <span aria-hidden>{title.slice(0, 2)}</span>;
};
