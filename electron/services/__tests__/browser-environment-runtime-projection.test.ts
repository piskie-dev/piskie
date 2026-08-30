import { describe, expect, it } from 'vitest';
import type { BrowserEnvironment } from '../../../shared/types/index.js';
import { BrowserEnvironmentRuntimeProjection } from '../browser-environment-runtime-projection.js';

function environment(overrides: Partial<BrowserEnvironment> = {}): BrowserEnvironment {
  return {
    id: 'environment-a',
    name: 'Environment A',
    identityPolicy: {
      timezone: { mode: 'real' },
      geolocation: { mode: 'off' },
      language: { mode: 'custom', value: 'en-US' },
    },
    proxyId: 'proxy-a',
    status: 'idle',
    createdAt: 1,
    ...overrides,
  };
}

describe('BrowserEnvironmentRuntimeProjection browser generation observations', () => {
  it('marks a running environment when launch-relevant configuration changes', () => {
    const projection = new BrowserEnvironmentRuntimeProjection();
    projection.publishConfigSnapshot({ environments: [environment()], groups: [] });
    projection.updateRuntimeEnvironment('environment-a', {
      status: 'running',
      currentBrowserId: 'browser-a',
      restartRequired: false,
    });

    projection.publishConfigSnapshot({
      environments: [environment({
        identityPolicy: {
          timezone: { mode: 'custom', value: 'Asia/Shanghai' },
          geolocation: { mode: 'off' },
          language: { mode: 'custom', value: 'zh-CN' },
        },
      })],
      groups: [],
    });

    expect(projection.getEnvironment('environment-a')).toMatchObject({
      status: 'running',
      currentBrowserId: 'browser-a',
      restartRequired: true,
    });
  });

  it('marks only running environments that reference a changed global proxy', () => {
    const projection = new BrowserEnvironmentRuntimeProjection();
    projection.publishConfigSnapshot({
      environments: [
        environment(),
        environment({ id: 'environment-b', proxyId: 'proxy-b' }),
      ],
      groups: [],
    });
    projection.updateRuntimeEnvironment('environment-a', { status: 'running', restartRequired: false });
    projection.updateRuntimeEnvironment('environment-b', { status: 'idle', restartRequired: false });

    projection.markProxyRestartRequired(new Set(['proxy-a', 'proxy-b']));

    expect(projection.getEnvironment('environment-a')?.restartRequired).toBe(true);
    expect(projection.getEnvironment('environment-b')?.restartRequired).toBe(false);
  });
});
