import { describe, expect, it } from 'vitest';

import {
  captureLoginShellEnvironment,
  parseShellEnvironmentOutput,
  resolveHostEnvironment,
  runShellCaptureProcess,
  ShellEnvironmentCaptureError,
} from '../host-environment.js';

function payload(environment: Record<string, string>): string {
  return Buffer.from(JSON.stringify(environment), 'utf8').toString('base64');
}

describe('shell environment capture', () => {
  it('ignores login-shell noise and parses only the marked Base64 JSON payload', () => {
    const marker = '__PISKIE_TEST__:';
    const environment = {
      PATH: '/custom/bin:/usr/bin',
      MULTILINE: 'first\nsecond',
      UNICODE: 'ok-\u4e2d\u6587',
    };

    expect(parseShellEnvironmentOutput(
      `welcome from zsh\n${marker}${payload(environment)}\ntrailing output\n`,
      marker,
    )).toEqual(environment);
  });

  it('uses the final marker when startup output contains an earlier lookalike', () => {
    const marker = '__PISKIE_TEST__:';
    const expected = { PATH: '/final/path' };
    const stdout = `${marker}not-base64!\nnoise\n${marker}${payload(expected)}\n`;

    expect(parseShellEnvironmentOutput(stdout, marker)).toEqual(expected);
  });

  it('passes executable and helper paths through environment variables instead of command interpolation', async () => {
    const marker = '__PISKIE_TEST__:';
    const captured = await captureLoginShellEnvironment({
      environment: { PATH: '/base/bin', DISPLAY: ':0' },
      executablePath: '/path with spaces/electron',
      helperPath: '/path with spaces/shell-env-helper.js',
      marker,
      platform: 'linux',
      shell: '/bin/bash',
      runProcess: async (request) => {
        expect(request.args).toHaveLength(2);
        expect(request.args[0]).toBe('-ilc');
        expect(request.args[1]).not.toContain('/path with spaces');
        expect(request.environment.PISKIE_ENV_CAPTURE_EXECUTABLE).toBe('/path with spaces/electron');
        expect(request.environment.PISKIE_ENV_CAPTURE_HELPER).toBe('/path with spaces/shell-env-helper.js');
        return `shell greeting\n${marker}${payload({ PATH: '/shell/bin', DISPLAY: ':0' })}\n`;
      },
    });

    expect(captured).toEqual({
      environment: { PATH: '/shell/bin', DISPLAY: ':0' },
      shell: '/bin/bash',
    });
  });

  it('falls back to the original process environment when capture fails', async () => {
    const resolved = await resolveHostEnvironment({
      environment: { PATH: '/fallback/bin', DISPLAY: ':9' },
      platform: 'linux',
      shell: '/bin/bash',
      runProcess: async () => {
        throw new ShellEnvironmentCaptureError('marker_missing', 'test failure');
      },
    });

    expect(resolved.environment).toEqual({ PATH: '/fallback/bin', DISPLAY: ':9' });
    expect(resolved.status).toMatchObject({
      state: 'fallback',
      source: 'process',
      failureCode: 'marker_missing',
      failureReason: 'test failure',
    });
  });

  it.runIf(process.platform !== 'win32')('terminates a capture process that exceeds its deadline', async () => {
    await expect(runShellCaptureProcess({
      shell: '/bin/sh',
      args: ['-c', 'sleep 5'],
      environment: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeoutMs: 50,
      maxOutputBytes: 1024,
    })).rejects.toMatchObject({ code: 'timeout' });
  });
});
