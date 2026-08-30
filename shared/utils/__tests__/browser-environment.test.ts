import { describe, expect, it } from 'vitest';
import {
  BROWSER_ENVIRONMENT_PURPOSE_MAX_LENGTH,
  clampBrowserEnvironmentPurpose,
  resolveBrowserEnvironmentPurpose,
} from '../browser-environment.js';

describe('browser environment purpose helpers', () => {
  it('trims purpose and treats blank as unset', () => {
    expect(clampBrowserEnvironmentPurpose('  TikTok 墨西哥店铺主账号  ')).toBe('TikTok 墨西哥店铺主账号');
    expect(clampBrowserEnvironmentPurpose('   ')).toBeUndefined();
    expect(clampBrowserEnvironmentPurpose(undefined)).toBeUndefined();
  });

  it('clamps purpose to 200 chars', () => {
    const long = 'a'.repeat(BROWSER_ENVIRONMENT_PURPOSE_MAX_LENGTH + 50);
    expect(clampBrowserEnvironmentPurpose(long)).toHaveLength(BROWSER_ENVIRONMENT_PURPOSE_MAX_LENGTH);
  });

  it('falls back to the explicit placeholder when purpose is unset', () => {
    expect(resolveBrowserEnvironmentPurpose({ purpose: 'TikTok 店铺运营' })).toBe('TikTok 店铺运营');
    expect(resolveBrowserEnvironmentPurpose({})).toBe('（未填写用途）');
  });
});
