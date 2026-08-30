import { describe, expect, it } from 'vitest';

import {
  coinDisplayName,
  forgeAuth,
  matchVendor,
  peekKey,
  pokeKey,
  vendorsFor,
} from '../vendor-atlas';

function shape(displayName: string, driver: string, baseUrl: string) {
  return { displayName, driver, connection: { baseUrl } } as Parameters<typeof matchVendor>[0];
}

describe('matchVendor', () => {
  it('端点指纹优先命中(名字对不上也认端点)', () => {
    const spec = matchVendor(shape('随便叫', 'openai', 'https://api.openai.com/v1'), 'ai');
    expect(spec.key).toBe('openai');
  });

  it('端点未命中时按显示名认定', () => {
    const spec = matchVendor(shape('我的 Groq 转发', 'openai', 'https://relay.example.com/v1'), 'ai');
    expect(spec.key).toBe('groq');
  });

  it('全部未命中回落同驱动的自定义预设', () => {
    const spec = matchVendor(shape('内网网关', 'anthropic-messages', 'https://gw.corp.local'), 'ai');
    expect(spec.key).toBe('anthropic-compatible');
  });

  it('生图网关独立图鉴:comfyui 端点命中', () => {
    const spec = matchVendor(shape('本机绘图', 'comfyui-workflow', 'http://127.0.0.1:8188'), 'image');
    expect(spec.key).toBe('comfyui');
  });
});

describe('forgeAuth / peekKey / pokeKey', () => {
  it('api_key 预设带自定义 header(gemini-image → x-goog-api-key)', () => {
    const gemini = vendorsFor('image').find((spec) => spec.key === 'gemini-image')!;
    const auth = forgeAuth(gemini, 'AIza-1');
    expect(auth).toEqual({ kind: 'api_key', header: 'x-goog-api-key', value: 'AIza-1' });
  });

  it('none 鉴权不携带密钥;bearer 密钥可 peek/poke 往返', () => {
    const ollama = vendorsFor('ai').find((spec) => spec.key === 'ollama')!;
    expect(forgeAuth(ollama, '忽略')).toEqual({ kind: 'none' });

    const bearer = forgeAuth(vendorsFor('ai').find((spec) => spec.key === 'openai')!, 'sk-a');
    expect(peekKey(bearer)).toBe('sk-a');
    expect(peekKey(pokeKey(bearer, 'sk-b'))).toBe('sk-b');
  });

  it('pokeKey 保留 aws auth 的非密钥字段', () => {
    const next = pokeKey(
      { kind: 'aws', accessKeyId: 'AK', secretAccessKey: 'old', region: 'ap-east-1', sessionToken: 'tok' },
      'new',
    );
    expect(next).toEqual({
      kind: 'aws', accessKeyId: 'AK', secretAccessKey: 'new', region: 'ap-east-1', sessionToken: 'tok',
    });
  });
});

describe('coinDisplayName', () => {
  it('被占用时追加序号且大小写不敏感', () => {
    expect(coinDisplayName('OpenAI', ['openai', 'OpenAI 2'])).toBe('OpenAI 3');
    expect(coinDisplayName('DeepSeek', ['OpenAI'])).toBe('DeepSeek');
  });
});
