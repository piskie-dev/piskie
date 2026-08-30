import { describe, expect, it, vi } from 'vitest';
import type { ProxyPoolSnapshot } from '../../../../../shared/types/proxy.js';
import { BrowserLaunchPlanner } from '../browser-launch-planner.js';
import {
  browserIdentityNeedsIp,
  resolveBrowserIdentity,
} from '../browser-identity-resolver.js';
import type { IpLocationResolver } from '../ip-location-resolver.js';

const proxyPool: ProxyPoolSnapshot = {
  proxies: [{
    id: 'proxy-a',
    name: 'Proxy A',
    protocol: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    username: 'proxy-user',
    password: 'proxy-password',
    enabled: true,
  }, {
    id: 'disabled',
    name: 'Disabled',
    protocol: 'http',
    host: '127.0.0.1',
    port: 8080,
    enabled: false,
  }],
};

function planner(location = vi.fn()) {
  return {
    location,
    planner: new BrowserLaunchPlanner({
      readProxies: () => structuredClone(proxyPool),
      location: { resolve: location } as unknown as IpLocationResolver,
      generation: () => 'generation-a',
    }),
  };
}

describe('BrowserLaunchPlanner', () => {
  it('resolves direct IP identity before producing an immutable launch spec', async () => {
    const { planner: subject, location } = planner(vi.fn(async (_route) => ({
      countryCode: 'CN',
      timezone: 'Asia/Shanghai',
      latitude: 31.23,
      longitude: 121.47,
    })));

    const spec = await subject.planEnvironment({
      browserId: 'browser-a',
      userDataId: 'data-a',
      backgroundMode: true,
      identityPolicy: {
        timezone: { mode: 'ip' },
        geolocation: { mode: 'ip' },
        language: { mode: 'ip' },
      },
    });

    expect(location).toHaveBeenCalledWith({ kind: 'direct' }, {});
    expect(spec).toMatchObject({
      generation: 'generation-a',
      identity: {
        timezone: 'Asia/Shanghai',
        language: 'zh-CN',
        geolocation: { latitude: 31.23, longitude: 121.47 },
      },
    });
    expect(spec).not.toHaveProperty('proxy');
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.identity)).toBe(true);
  });

  it('uses the same proxy route for location and Chromium launch materialization', async () => {
    const { planner: subject, location } = planner(vi.fn(async () => ({
      countryCode: 'US',
    })));

    const spec = await subject.planEnvironment({
      browserId: 'browser-a',
      userDataId: 'data-a',
      proxyId: 'proxy-a',
      backgroundMode: false,
      identityPolicy: {
        timezone: { mode: 'real' },
        geolocation: { mode: 'off' },
        language: { mode: 'ip' },
      },
    });

    expect(location).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'proxy',
      profile: expect.objectContaining({ password: 'proxy-password' }),
    }), {});
    expect(spec.proxy).toEqual({
      server: 'socks5://127.0.0.1:1080',
      username: 'proxy-user',
      password: 'proxy-password',
    });
    expect(spec.identity).toEqual({ language: 'en-US' });
    expect(spec.fingerprint).toMatchObject({ geoMode: 'block' });
  });

  it('does not call IP location for an all-custom identity', async () => {
    const { planner: subject, location } = planner();
    const spec = await subject.planEnvironment({
      browserId: 'browser-a',
      userDataId: 'data-a',
      backgroundMode: false,
      identityPolicy: {
        userAgent: 'Piskie Browser',
        timezone: { mode: 'custom', value: 'Europe/Paris' },
        geolocation: { mode: 'custom', latitude: 48.86, longitude: 2.35, accuracy: 20 },
        language: { mode: 'custom', value: 'fr-FR' },
      },
    });

    expect(location).not.toHaveBeenCalled();
    expect(spec.identity).toEqual({
      userAgent: 'Piskie Browser',
      timezone: 'Europe/Paris',
      language: 'fr-FR',
      geolocation: { latitude: 48.86, longitude: 2.35, accuracy: 20 },
    });
  });

  it.each(['missing', 'disabled'])('rejects %s proxy before location or spawn', async (proxyId) => {
    const { planner: subject, location } = planner();
    await expect(subject.planEnvironment({
      browserId: 'browser-a',
      userDataId: 'data-a',
      proxyId,
      backgroundMode: false,
      identityPolicy: {
        timezone: { mode: 'real' },
        geolocation: { mode: 'off' },
        language: { mode: 'custom', value: 'en-US' },
      },
    })).rejects.toThrow(`missing or disabled: ${proxyId}`);
    expect(location).not.toHaveBeenCalled();
  });
});

describe('Browser identity resolution', () => {
  it('requires every requested IP-derived dimension and leaves real/off overrides absent', () => {
    expect(browserIdentityNeedsIp({
      timezone: { mode: 'real' },
      geolocation: { mode: 'off' },
      language: { mode: 'custom', value: 'en-US' },
    })).toBe(false);

    expect(resolveBrowserIdentity({
      timezone: { mode: 'real' },
      geolocation: { mode: 'off' },
      language: { mode: 'custom', value: 'en-US' },
    })).toEqual({
      identity: { language: 'en-US' },
      fingerprint: { clientHintsFromUA: true, geoMode: 'block' },
    });

    expect(() => resolveBrowserIdentity({
      timezone: { mode: 'ip' },
      geolocation: { mode: 'off' },
      language: { mode: 'custom', value: 'en-US' },
    }, {})).toThrow('timezone');
    expect(() => resolveBrowserIdentity({
      timezone: { mode: 'real' },
      geolocation: { mode: 'ip' },
      language: { mode: 'custom', value: 'en-US' },
    }, {})).toThrow('coordinates');
    expect(() => resolveBrowserIdentity({
      timezone: { mode: 'real' },
      geolocation: { mode: 'off' },
      language: { mode: 'ip' },
    }, { countryCode: 'ZZ' })).toThrow('country code');
  });
});
