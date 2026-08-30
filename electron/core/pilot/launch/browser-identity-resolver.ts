import type { BrowserLaunchIdentity } from '../../../piskiepilot/browser/core/browser/browser-launch-spec.js';
import type { BrowserIdentityPolicy, RuntimeFingerprintConfig } from '../../../../shared/types/index.js';
import type { IpLocationSnapshot } from './browser-launch-types.js';

const COUNTRY_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  MX: 'es-MX', BR: 'pt-BR', AR: 'es-AR', CL: 'es-CL', CO: 'es-CO', PE: 'es-PE',
  US: 'en-US', CA: 'en-CA', GB: 'en-GB', AU: 'en-AU',
  CN: 'zh-CN', HK: 'zh-HK', TW: 'zh-TW', JP: 'ja-JP', KR: 'ko-KR',
  ES: 'es-ES', DE: 'de-DE', FR: 'fr-FR', IT: 'it-IT', PT: 'pt-PT',
  RU: 'ru-RU', TR: 'tr-TR', VN: 'vi-VN', TH: 'th-TH', ID: 'id-ID',
});

export interface ResolvedBrowserIdentity {
  identity: BrowserLaunchIdentity;
  fingerprint: RuntimeFingerprintConfig;
}

export function browserIdentityNeedsIp(policy: BrowserIdentityPolicy): boolean {
  return policy.timezone.mode === 'ip'
    || policy.geolocation.mode === 'ip'
    || policy.language.mode === 'ip';
}

export function resolveBrowserIdentity(
  policy: BrowserIdentityPolicy,
  location?: IpLocationSnapshot,
): ResolvedBrowserIdentity {
  if (browserIdentityNeedsIp(policy) && !location) {
    throw new Error('Browser identity requires an IP location snapshot');
  }

  let timezone: string | undefined;
  if (policy.timezone.mode === 'custom') timezone = policy.timezone.value;
  if (policy.timezone.mode === 'ip') {
    if (!location?.timezone) throw new Error('IP location did not provide a timezone');
    timezone = location.timezone;
  }

  let geolocation: BrowserLaunchIdentity['geolocation'];
  if (policy.geolocation.mode === 'custom') {
    geolocation = {
      latitude: policy.geolocation.latitude,
      longitude: policy.geolocation.longitude,
      ...(policy.geolocation.accuracy !== undefined
        ? { accuracy: policy.geolocation.accuracy }
        : {}),
    };
  }
  if (policy.geolocation.mode === 'ip') {
    if (location?.latitude === undefined || location.longitude === undefined) {
      throw new Error('IP location did not provide coordinates');
    }
    geolocation = {
      latitude: location.latitude,
      longitude: location.longitude,
    };
  }

  let language: string | undefined;
  if (policy.language.mode === 'custom') language = policy.language.value;
  if (policy.language.mode === 'ip') {
    language = location?.countryCode
      ? COUNTRY_LANGUAGE[location.countryCode.toUpperCase()]
      : undefined;
    if (!language) throw new Error('IP location did not provide a supported country code');
  }

  return {
    identity: {
      ...(language ? { language } : {}),
      ...(timezone ? { timezone } : {}),
      ...(policy.userAgent ? { userAgent: policy.userAgent } : {}),
      ...(geolocation ? { geolocation } : {}),
    },
    fingerprint: {
      ...(policy.platform ? { platform: policy.platform } : {}),
      clientHintsFromUA: true,
      ...(policy.geolocation.mode === 'off' ? { geoMode: 'block' as const } : {}),
      ...(policy.hardwareConcurrency !== undefined
        ? { hardwareConcurrency: policy.hardwareConcurrency }
        : {}),
      ...(policy.extra ? { extra: structuredClone(policy.extra) } : {}),
    },
  };
}
