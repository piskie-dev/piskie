import { platform as osPlatform } from 'node:os';

import { deriveUAMetadata } from '../core/browser/ua-metadata.js';
import type { FpPlatform, FpUserConfig } from './config.js';
import { FingerprintBrowser } from './manager.js';

/** Process-owned fingerprint browser lifecycle used by BrowserManager. */
export const fingerprintBrowser = new FingerprintBrowser();

function hostFpPlatform(): FpPlatform {
  const platform = osPlatform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

export interface EnvFingerprintForKernel {
  platform?: FpPlatform;
  clientHintsFromUA?: boolean;
  hardwareConcurrency?: number;
  geoMode?: 'block' | 'real';
  extra?: Record<string, unknown>;
}

export function toFpUserConfig(
  config: {
    language?: string;
    timezone?: string;
    userAgent?: string;
    geolocation?: { latitude: number; longitude: number; accuracy?: number };
    proxy?: { server: string; username?: string; password?: string };
    fingerprint?: EnvFingerprintForKernel;
  },
  userDataDir: string,
): FpUserConfig {
  const fingerprint = config.fingerprint;
  return {
    ...kernelFingerprintExtras(fingerprint?.extra),
    platform: fingerprint?.platform ?? hostFpPlatform(),
    hardwareConcurrency: fingerprint?.hardwareConcurrency,
    blockGeolocation: fingerprint?.geoMode === 'block',
    locale: config.language,
    acceptLanguage: config.language
      ? `${config.language},${config.language.split('-')[0]}`
      : undefined,
    timezone: config.timezone,
    userAgent: config.userAgent,
    userAgentMetadata: config.userAgent && fingerprint?.clientHintsFromUA
      ? (deriveUAMetadata(config.userAgent) as unknown as Record<string, unknown> | undefined)
      : undefined,
    geo: config.geolocation,
    proxy: config.proxy,
    userDataDir,
    headless: false,
  };
}

function kernelFingerprintExtras(extra: Record<string, unknown> | undefined): Partial<FpUserConfig> {
  if (!extra) return {};
  return {
    ...(typeof extra.platformVersion === 'string' ? { platformVersion: extra.platformVersion } : {}),
    ...(typeof extra.gpuVendor === 'string' ? { gpuVendor: extra.gpuVendor } : {}),
    ...(typeof extra.gpuRenderer === 'string' ? { gpuRenderer: extra.gpuRenderer } : {}),
    ...(typeof extra.brand === 'string' ? { brand: extra.brand } : {}),
    ...(typeof extra.brandOverride === 'boolean' ? { brandOverride: extra.brandOverride } : {}),
    ...(typeof extra.deviceScaleFactor === 'number' && extra.deviceScaleFactor > 0
      ? { deviceScaleFactor: extra.deviceScaleFactor }
      : {}),
  };
}
