import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveRendererEntryUrl } from '../renderer-entry.js';
import { resolveRuntimeProfile } from '../runtime-profile.js';

const baseInput = {
  appPath: '/opt/Piskie App',
};

describe('RuntimeProfile', () => {
  it('selects development defaults from the bootstrap environment once', () => {
    const profile = resolveRuntimeProfile({
      ...baseInput,
      env: { NODE_ENV: 'development' },
    });

    expect(profile).toMatchObject({
      accountBaseUrl: 'https://www.piskie.dev',
      development: true,
      sandboxFallback: false,
      rendererEntryUrl: 'http://127.0.0.1:5174/',
      logLevel: 'debug',
    });
  });

  it('uses packaged defaults and ignores a production Renderer override', () => {
    const profile = resolveRuntimeProfile({
      ...baseInput,
      env: {
        NODE_ENV: 'unexpected',
        PISKIE_RENDERER_URL: 'https://renderer.example.test',
        PISKIE_LOG_LEVEL: 'verbose',
      },
    });

    expect(profile.development).toBe(false);
    expect(profile.logLevel).toBe('info');
    expect(profile.logLevelIssue).toEqual({ requestedLevel: 'verbose' });
    expect(fileURLToPath(profile.rendererEntryUrl)).toBe('/opt/Piskie App/dist/index.html');
  });

  it('accepts explicit development Renderer and log settings', () => {
    const profile = resolveRuntimeProfile({
      ...baseInput,
      env: {
        NODE_ENV: 'development',
        PISKIE_RENDERER_URL: 'https://localhost:6000/ui',
        PISKIE_LOG_LEVEL: 'warn',
      },
    });

    expect(profile.rendererEntryUrl).toBe('https://localhost:6000/ui');
    expect(profile.logLevel).toBe('warn');
  });

  it('allows an HTTPS account service override only in development', () => {
    const preview = 'https://piskie-site-preview.example.workers.dev';
    expect(resolveRuntimeProfile({
      ...baseInput,
      env: { NODE_ENV: 'development', PISKIE_ACCOUNT_BASE_URL: preview },
    }).accountBaseUrl).toBe(preview);
    expect(resolveRuntimeProfile({
      ...baseInput,
      env: { NODE_ENV: 'production', PISKIE_ACCOUNT_BASE_URL: preview },
    }).accountBaseUrl).toBe('https://www.piskie.dev');
  });

  it('rejects an insecure remote account service override', () => {
    expect(() => resolveRuntimeProfile({
      ...baseInput,
      env: { NODE_ENV: 'development', PISKIE_ACCOUNT_BASE_URL: 'http://example.com' },
    })).toThrow('HTTPS');
  });

  it("accepts only the launcher's exact sandbox fallback marker", () => {
    expect(
      resolveRuntimeProfile({
        ...baseInput,
        env: { PISKIE_ELECTRON_SANDBOX_FALLBACK: '1' },
      }).sandboxFallback
    ).toBe(true);
    expect(
      resolveRuntimeProfile({
        ...baseInput,
        env: { PISKIE_ELECTRON_SANDBOX_FALLBACK: 'true' },
      }).sandboxFallback
    ).toBe(false);
  });
});

describe('resolveRendererEntryUrl', () => {
  it('encodes special packaged paths with pathToFileURL', () => {
    const appPath = path.join('/tmp', 'Desktop App #1?');
    const result = resolveRendererEntryUrl({ development: false, appPath });

    expect(result).toContain('Desktop%20App%20%231%3F');
    expect(fileURLToPath(result)).toBe(path.join(appPath, 'dist', 'index.html'));
  });

  it('rejects non-http development entries', () => {
    expect(() =>
      resolveRendererEntryUrl({
        development: true,
        appPath: '/tmp/app',
        devServerUrl: 'file:///tmp/index.html',
      })
    ).toThrow('http or https');
  });
});
