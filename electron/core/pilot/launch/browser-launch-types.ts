import type { BrowserLaunchIdentity } from '../../../piskiepilot/browser/core/browser/browser-launch-spec.js';
import type { BrowserIdentityPolicy, RuntimeFingerprintConfig } from '../../../../shared/types/index.js';
import type { ProxyProfile } from '../../../../shared/types/proxy.js';

export type EffectiveNetworkRoute =
  | { kind: 'direct' }
  | { kind: 'proxy'; profile: ProxyProfile };

export interface IpLocationSnapshot {
  countryCode?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
}

interface BrowserLaunchRequestBase {
  browserId: string;
  userDataId: string;
  proxyId?: string;
  backgroundMode: boolean;
}

export interface BrowserEnvironmentLaunchRequest extends BrowserLaunchRequestBase {
  identityPolicy: BrowserIdentityPolicy;
}

export interface BrowserTaskLaunchRequest extends BrowserLaunchRequestBase {
  identity: BrowserLaunchIdentity;
  fingerprint?: RuntimeFingerprintConfig;
}

export interface BrowserLaunchPlanOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
}
