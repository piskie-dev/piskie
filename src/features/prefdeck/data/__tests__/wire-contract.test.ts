import { describe, expect, it } from 'vitest';

import type { ConfigDescriptor } from '../../../../../shared/types/config';
import { pickWire, readWirePact, stampWire } from '../wire-contract';

function descriptorWith(wireApi: unknown): ConfigDescriptor {
  return {
    dynamicExtensions: [{
      kind: 'inference-driver',
      selector: { value: 'openai' },
      schemas: [{ name: 'providerOptions', schema: { properties: { wireApi } } }],
    }],
  } as unknown as ConfigDescriptor;
}

const FIELD = {
  description: '该 Provider 下所有 AI 模型共用的线协议。',
  default: 'responses',
  anyOf: [
    { const: 'responses', title: 'Responses', description: '推荐用于 Agent 工具与推理。' },
    { const: 'chat-completions', title: 'Chat Completions', description: '经典聊天补全协议。' },
  ],
  'x-piskie': { changeImpact: '切换后测试连接与实际调用都用该协议。' },
};

describe('readWirePact', () => {
  it('解析枚举/缺省/impact', () => {
    const pact = readWirePact(descriptorWith(FIELD));
    expect(pact).toBeDefined();
    expect(pact!.fallback).toBe('responses');
    expect(pact!.choices.map((c) => c.value)).toEqual(['responses', 'chat-completions']);
    expect(pact!.impact).toContain('测试连接');
  });

  it('缺省值不在枚举内 / 结构缺失 → undefined', () => {
    expect(readWirePact(descriptorWith({ ...FIELD, default: '不存在' }))).toBeUndefined();
    expect(readWirePact(null)).toBeUndefined();
  });
});

describe('pickWire / stampWire', () => {
  const pact = readWirePact(descriptorWith(FIELD))!;

  it('存储值合法则用之,非法回落缺省;stamp 保留其余 driverOptions', () => {
    expect(pickWire({ wireApi: 'chat-completions' }, pact)).toBe('chat-completions');
    expect(pickWire({ wireApi: '野值' }, pact)).toBe('responses');
    expect(pickWire(undefined, pact)).toBe('responses');
    expect(stampWire({ other: 1 }, 'chat-completions')).toEqual({ other: 1, wireApi: 'chat-completions' });
  });
});
