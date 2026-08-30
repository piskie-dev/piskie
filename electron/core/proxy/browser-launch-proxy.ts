import type { BrowserLaunchProxy } from '../../piskiepilot/browser/core/browser/browser-launch-spec.js';
import type { ProxyProfile } from '../../../shared/types/proxy.js';

export function toBrowserLaunchProxy(profile: ProxyProfile): BrowserLaunchProxy {
  return {
    server: `${profile.protocol}://${profile.host}:${profile.port}`,
    ...(profile.username ? { username: profile.username } : {}),
    ...(profile.password ? { password: profile.password } : {}),
  };
}
