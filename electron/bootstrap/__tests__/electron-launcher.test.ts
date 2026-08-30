import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  SANDBOX_FALLBACK_ENV,
  assessLinuxSandbox,
  buildElectronInvocation,
  parseLauncherArguments,
  resolveElectronBinary,
} from '../../../scripts/electron-launcher.mjs';

const binaryPath = '/opt/piskie/electron';

describe('Electron launcher sandbox policy', () => {
  it('keeps a valid root-owned setuid sandbox', () => {
    const probeUserNamespace = vi.fn(() => 'unavailable');
    const assessment = assessLinuxSandbox({
      binaryPath,
      statHelper: () => ({ uid: 0, mode: 0o104755, isFile: () => true }),
      probeUserNamespace,
    });

    expect(assessment).toEqual({ mode: 'setuid', args: [] });
    expect(probeUserNamespace).not.toHaveBeenCalled();
  });

  it('uses user namespaces when the setuid helper is invalid', () => {
    expect(
      assessLinuxSandbox({
        binaryPath,
        statHelper: () => ({ uid: 1000, mode: 0o100755, isFile: () => true }),
        probeUserNamespace: () => 'available',
      })
    ).toEqual({
      mode: 'user-namespace',
      args: ['--disable-setuid-sandbox'],
      reason: 'invalid-setuid-helper',
    });
  });

  it('falls back when neither Linux sandbox mechanism is available', () => {
    expect(
      assessLinuxSandbox({
        binaryPath,
        statHelper: () => ({ uid: 1000, mode: 0o100755, isFile: () => true }),
        probeUserNamespace: () => 'unavailable',
      })
    ).toEqual({
      mode: 'disabled',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      reason: 'invalid-setuid-helper-and-user-namespace-unavailable',
    });
  });

  it('injects fallback flags and the bounded logging marker before the app path', () => {
    const invocation = buildElectronInvocation({
      binaryPath,
      appPath: '/opt/piskie/app',
      passthroughArgs: ['--remote-debugging-port=9223'],
      platform: 'linux',
      environment: { ELECTRON_RUN_AS_NODE: '1' },
      sandboxAssessment: {
        mode: 'disabled',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        reason: 'test-unavailable',
      },
    });

    expect(invocation.args).toEqual([
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '/opt/piskie/app',
      '--remote-debugging-port=9223',
    ]);
    expect(invocation.environment.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(invocation.environment[SANDBOX_FALLBACK_ENV]).toBe('1');
  });

  it('parses packaged and development launch forms without exposing launcher flags', () => {
    expect(
      parseLauncherArguments(['--binary', './electron', '--app', './app', '--', '--inspect=9229'])
    ).toEqual({
      binaryPath: path.resolve('./electron'),
      appPath: path.resolve('./app'),
      passthroughArgs: ['--inspect=9229'],
    });

    expect(
      parseLauncherArguments(['--app', './app', '--', '--remote-debugging-port=9223'])
    ).toEqual({
      binaryPath: undefined,
      appPath: path.resolve('./app'),
      passthroughArgs: ['--remote-debugging-port=9223'],
    });
  });

  it('uses the platform executable exposed by the electron package without rewriting it', () => {
    const macBinary = '/work/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
    const windowsBinary = String.raw`C:\work\node_modules\electron\dist\electron.exe`;

    expect(resolveElectronBinary(() => macBinary)).toBe(macBinary);
    expect(resolveElectronBinary(() => windowsBinary)).toBe(windowsBinary);
    expect(() => resolveElectronBinary(() => undefined)).toThrow(
      'The electron package did not resolve to an executable path'
    );
  });

  it('keeps the development command independent of a platform-specific Electron layout', () => {
    const packageMetadata = JSON.parse(
      fs.readFileSync(path.resolve('package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    const command = packageMetadata.scripts['dev:electron'];

    expect(command).toContain('node scripts/electron-launcher.mjs --app .');
    expect(command).not.toContain('--binary');
    expect(command).not.toContain('node_modules/electron/dist/electron');
  });
});
