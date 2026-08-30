import { describe, expect, it } from 'vitest';
import { toFpUserConfig } from '../runtime.js';
import { resolveConfig } from '../config.js';

describe('kernel fingerprint config mapping', () => {
  it('maps locale, timezone, geo, proxy and native geo blocking without screen overrides', () => {
    const mapped = toFpUserConfig(
      {
        language: 'zh-CN',
        timezone: 'Asia/Shanghai',
        geolocation: { latitude: 31.23, longitude: 121.47 },
        proxy: { server: 'http://127.0.0.1:8080', username: 'user', password: 'pass' },
        fingerprint: {
          platform: 'windows',
          clientHintsFromUA: true,
          hardwareConcurrency: 12,
          geoMode: 'block',
          extra: {
            gpuVendor: 'Test GPU Vendor',
            deviceScaleFactor: 1.5,
            extraArgs: ['--proxy-server=http://forbidden.test'],
            executablePath: '/tmp/forbidden-browser',
          },
        },
      },
      '/tmp/profile/chrome-data',
    );

    expect(mapped).toMatchObject({
      platform: 'windows',
      locale: 'zh-CN',
      acceptLanguage: 'zh-CN,zh',
      timezone: 'Asia/Shanghai',
      hardwareConcurrency: 12,
      blockGeolocation: true,
      gpuVendor: 'Test GPU Vendor',
      deviceScaleFactor: 1.5,
      userDataDir: '/tmp/profile/chrome-data',
    });
    expect(mapped).not.toHaveProperty('screen');
    expect(mapped).not.toHaveProperty('extraArgs');
    expect(mapped).not.toHaveProperty('executablePath');
  });

  it('derives UA metadata when possible and never rejects an otherwise valid custom UA', () => {
    const edge = toFpUserConfig(
      {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
        fingerprint: { platform: 'macos', clientHintsFromUA: true },
      },
      '/tmp/edge',
    );
    expect(edge.userAgentMetadata).toMatchObject({ platform: 'Windows' });

    const unparseable = toFpUserConfig(
      {
        userAgent: 'Custom Browser UA',
        fingerprint: { platform: 'linux', clientHintsFromUA: true },
      },
      '/tmp/custom',
    );
    expect(unparseable.userAgent).toBe('Custom Browser UA');
    expect(unparseable.userAgentMetadata).toBeUndefined();
  });

  it('keeps screen dimensions native while retaining the target-platform DPR flag', () => {
    const config = resolveConfig('profile-a', { platform: 'macos' });
    expect(config.deviceScaleFactor).toBe(2);
    expect(config).not.toHaveProperty('screen');
  });
});
