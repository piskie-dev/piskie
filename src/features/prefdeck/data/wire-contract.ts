/**
 * openai 驱动的 API 线协议契约（重写）。
 *
 * 契约来自主进程的 ConfigDescriptor dynamicExtensions(inference-driver / openai
 * 的 providerOptions.wireApi JSON Schema):枚举各协议(anyOf const+title+description)、
 * 缺省值与 x-piskie 元数据(changeImpact 等)。协议作用于整个 Provider。
 */

import type { ConfigDescriptor } from '../../../../shared/types/config';
import { recordOf } from './record-shape';

export interface WireChoice {
  readonly value: string;
  readonly title: string;
  readonly brief: string;
}

export interface WirePact {
  readonly brief: string;
  readonly fallback: string;
  readonly choices: readonly WireChoice[];
  readonly impact?: string;
}

/** 从描述符解析线协议契约;结构不满足即返回 undefined(UI 隐藏该控件) */
export function readWirePact(descriptor: ConfigDescriptor | null): WirePact | undefined {
  const extension = descriptor?.dynamicExtensions.find((entry) => (
    entry.kind === 'inference-driver' && entry.selector.value === 'openai'
  ));
  const schema = extension?.schemas.find((entry) => entry.name === 'providerOptions');
  const field = recordOf(recordOf(schema?.schema.properties)?.wireApi);
  const variants = Array.isArray(field?.anyOf) ? field.anyOf : [];

  const choices = variants.flatMap((variant): WireChoice[] => {
    const shape = recordOf(variant);
    if (typeof shape?.const !== 'string' || shape.const.length === 0
      || typeof shape.title !== 'string' || typeof shape.description !== 'string') return [];
    return [{ value: shape.const, title: shape.title, brief: shape.description }];
  });

  if (typeof field?.description !== 'string'
    || typeof field.default !== 'string'
    || !choices.some((choice) => choice.value === field.default)) return undefined;

  const meta = recordOf(field['x-piskie']);
  return {
    brief: field.description,
    fallback: field.default,
    choices,
    ...(typeof meta?.changeImpact === 'string' && { impact: meta.changeImpact }),
  };
}

/** 当前生效的协议值(未配置或非法值回落契约缺省) */
export function pickWire(
  driverOptions: Readonly<Record<string, unknown>> | undefined,
  pact: WirePact,
): string {
  const stored = driverOptions?.wireApi;
  return typeof stored === 'string' && pact.choices.some((choice) => choice.value === stored)
    ? stored
    : pact.fallback;
}

/** 写入协议值,保留其余 driverOptions */
export function stampWire(
  driverOptions: Readonly<Record<string, unknown>>,
  wireApi: string,
): Record<string, unknown> {
  return { ...driverOptions, wireApi };
}
