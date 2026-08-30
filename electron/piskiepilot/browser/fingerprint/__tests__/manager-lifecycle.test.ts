import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const binary = vi.hoisted(() => ({
  resolveExecutable: vi.fn(),
}));

const runtime = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
  connectError: undefined as Error | undefined,
  controls: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: runtime.spawn,
    execFileSync: runtime.execFileSync,
  };
});

vi.mock('../binary.js', () => ({
  resolveExecutable: binary.resolveExecutable,
}));

vi.mock('../cdp-control.js', () => ({
  CdpControl: class {
    close = vi.fn();
    connect = vi.fn(async () => {
      if (runtime.connectError) throw runtime.connectError;
    });

    constructor() {
      runtime.controls.push(this);
    }
  },
}));

import { FingerprintBrowser } from '../manager.js';

interface FakeProcess extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

let root: string;
let nextPid: number;

function fakeProcess(pid = nextPid++): FakeProcess {
  const process = new EventEmitter() as FakeProcess;
  process.pid = pid;
  process.exitCode = null;
  process.signalCode = null;
  process.stderr = new PassThrough();
  process.kill = vi.fn(() => true);
  return process;
}

function installNormalSpawn(): void {
  runtime.spawn.mockImplementation((_executable: string, args: string[]) => {
    const process = fakeProcess();
    const userDataArg = args.find((arg) => arg.startsWith('--user-data-dir='));
    if (!userDataArg) throw new Error('missing user-data-dir');
    const userDataDir = userDataArg.slice('--user-data-dir='.length);
    writeFileSync(
      join(userDataDir, 'DevToolsActivePort'),
      `9229\n/devtools/browser/test-${process.pid}\n`,
    );
    return process;
  });
}

async function stopWithoutWaiting(
  browser: FingerprintBrowser,
  profileId: string,
): Promise<boolean> {
  vi.useFakeTimers();
  vi.spyOn(browser as never, 'killTree').mockImplementation((process: FakeProcess) => {
    process.exitCode = 0;
  });
  const stopping = browser.stop(profileId);
  await vi.advanceTimersByTimeAsync(300);
  const result = await stopping;
  vi.useRealTimers();
  return result;
}

describe('FingerprintBrowser managed process lifecycle', () => {
  beforeEach(() => {
    binary.resolveExecutable.mockReset();
    binary.resolveExecutable.mockResolvedValue('/tmp/fingerprint-chromium');
    runtime.spawn.mockReset();
    runtime.execFileSync.mockReset();
    runtime.connectError = undefined;
    runtime.controls.length = 0;
    root = mkdtempSync(join(tmpdir(), 'fp-manager-lifecycle-'));
    nextPid = 4100;
    installNormalSpawn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('launches with an OS-assigned debug port and exposes the managed PID', async () => {
    const browser = new FingerprintBrowser();
    const handle = await browser.launch('profile-a', {
      platform: 'macos',
      userDataDir: join(root, 'profile-a'),
      proxy: {
        server: 'http://127.0.0.1:8080',
        username: 'proxy-user',
        password: 'proxy-password',
      },
      extraArgs: [
        '--proxy-bypass-list=localhost',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    });

    const args = runtime.spawn.mock.calls[0][1] as string[];
    expect(args).toContain('--remote-debugging-port=0');
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).toContain('--fingerprint-device-scale-factor=2');
    expect(args.some((arg) => arg.startsWith('--fingerprint-screen-'))).toBe(false);
    expect(args).toContain('--proxy-server=http://127.0.0.1:8080');
    expect(args).toContain('--proxy-bypass-list=localhost');
    expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(args.join('\n')).not.toContain('proxy-password');
    expect(handle.browserWSEndpoint).toContain('/devtools/browser/test-4100');
    expect(browser.getPid('profile-a')).toBe(4100);
    expect(runtime.controls[0].connect).toHaveBeenCalledOnce();
    expect(runtime.execFileSync).not.toHaveBeenCalled();
    expect(runtime.spawn).toHaveBeenCalledOnce();

    await expect(stopWithoutWaiting(browser, 'profile-a')).resolves.toBe(true);
    expect(runtime.controls[0].close).toHaveBeenCalledOnce();
    expect(browser.has('profile-a')).toBe(false);
  });

  it('terminates the spawned process and clears ownership when CDP initialization fails', async () => {
    const browser = new FingerprintBrowser();
    runtime.connectError = new Error('CDP initialization failed');
    runtime.spawn.mockImplementation((_executable: string, args: string[]) => {
      const process = fakeProcess();
      process.pid = undefined;
      const userDataArg = args.find((arg) => arg.startsWith('--user-data-dir='))!;
      writeFileSync(
        join(userDataArg.slice('--user-data-dir='.length), 'DevToolsActivePort'),
        '9229\n/devtools/browser/cdp-failure\n',
      );
      return process;
    });

    await expect(browser.launch('cdp-failure', {
      userDataDir: join(root, 'cdp-failure'),
    })).rejects.toThrow('CDP initialization failed');

    expect(runtime.controls.every((control) => control.close.mock.calls.length === 1)).toBe(true);
    expect(browser.has('cdp-failure')).toBe(false);
  });

  it.runIf(process.platform === 'linux')(
    'retries once with the sandbox disabled after a recognized Chromium diagnostic', async () => {
      const browser = new FingerprintBrowser();
      const failed = fakeProcess();
      runtime.spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          failed.stderr.end('FATAL: No usable sandbox!');
          failed.exitCode = 1;
          failed.emit('exit', 1, null);
        });
        return failed;
      });

      await browser.launch('profile-a', {
        userDataDir: join(root, 'profile-a'),
      });

      expect(browser.has('profile-a')).toBe(true);
      expect(runtime.spawn).toHaveBeenCalledTimes(2);
      expect(runtime.spawn.mock.calls[0][1]).not.toContain('--no-sandbox');
      expect(runtime.spawn.mock.calls[1][1]).toEqual(expect.arrayContaining([
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ]));
      await stopWithoutWaiting(browser, 'profile-a');
    },
  );

  it.runIf(process.platform === 'linux')(
    'does not disable the sandbox for a spawn permission error', async () => {
      const browser = new FingerprintBrowser();
      const failed = fakeProcess();
      failed.pid = undefined;
      runtime.spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          failed.stderr.end();
          failed.emit('error', new Error('spawn EACCES'));
        });
        return failed;
      });

      await expect(browser.launch('spawn-failure', {
        userDataDir: join(root, 'spawn-failure'),
      })).rejects.toThrow('spawn EACCES');

      expect(runtime.spawn).toHaveBeenCalledOnce();
      expect(browser.has('spawn-failure')).toBe(false);
    },
  );

  it.runIf(process.platform === 'linux')(
    'does not disable the sandbox for an unrelated early exit', async () => {
      const browser = new FingerprintBrowser();
      const failed = fakeProcess();
      runtime.spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          failed.stderr.end('profile lock is held');
          failed.exitCode = 1;
          failed.emit('exit', 1, null);
        });
        return failed;
      });

      await expect(browser.launch('early-exit', {
        userDataDir: join(root, 'early-exit'),
      })).rejects.toThrow('exited before DevTools was ready');

      expect(runtime.spawn).toHaveBeenCalledOnce();
      expect(browser.has('early-exit')).toBe(false);
    },
  );

  it.runIf(process.platform === 'linux')(
    'rejects and clears ownership when the no-sandbox retry also fails', async () => {
      const browser = new FingerprintBrowser();
      const first = fakeProcess();
      const fallback = fakeProcess();
      fallback.pid = undefined;
      runtime.spawn
        .mockImplementationOnce(() => {
          queueMicrotask(() => {
            first.stderr.end('Failed to move to new namespace: Operation not permitted');
            first.exitCode = 1;
            first.emit('exit', 1, null);
          });
          return first;
        })
        .mockImplementationOnce(() => {
          queueMicrotask(() => {
            fallback.stderr.end();
            fallback.emit('error', new Error('fallback spawn EACCES'));
          });
          return fallback;
        });

      await expect(
        browser.launch('double-failure', { userDataDir: join(root, 'double-failure') }),
      ).rejects.toThrow('fallback spawn EACCES');

      expect(runtime.spawn).toHaveBeenCalledTimes(2);
      expect(runtime.spawn.mock.calls[1][1]).toContain('--no-sandbox');
      expect(browser.has('double-failure')).toBe(false);
    },
  );

  it.runIf(process.platform !== 'linux')(
    'cleans ownership without retrying when no-sandbox fallback is unsupported', async () => {
      const browser = new FingerprintBrowser();
      const process = fakeProcess();
      runtime.spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          process.stderr.end('No usable sandbox!');
          process.exitCode = 1;
          process.emit('exit', 1, null);
        });
        return process;
      });

      await expect(
        browser.launch('early-exit', { userDataDir: join(root, 'early-exit') }),
      ).rejects.toThrow('exited before DevTools was ready');

      expect(runtime.spawn).toHaveBeenCalledOnce();
      expect(browser.has('early-exit')).toBe(false);
    },
  );

});
