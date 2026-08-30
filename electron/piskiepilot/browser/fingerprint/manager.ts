/**
 * FingerprintBrowser: launch(profileId, config) -> isolated profile + managed kernel process.
 * Consumers connect through Puppeteer/Playwright while this module keeps the native CDP
 * configuration channel alive for the lifetime of the browser.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, type FpConfig, type FpUserConfig } from './config.js';
import { resolveExecutable } from './binary.js';
import { CdpControl } from './cdp-control.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const STARTUP_DIAGNOSTIC_LIMIT = 16 * 1024;

export interface FpHandle {
  seed: number;
  config: FpConfig;
  browserWSEndpoint: string;
}

interface Session {
  control: CdpControl;
}

async function getDevToolsEndpoint(
  userDataDir: string,
  tries = 120,
): Promise<string> {
  const activePortFile = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < tries; i++) {
    try {
      const [portLine, pathLine] = readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && pathLine?.startsWith('/devtools/browser/')) {
        return `ws://127.0.0.1:${port}${pathLine}`;
      }
    } catch {
      // Chromium has not published its endpoint yet.
    }
    await sleep(100);
  }
  throw new Error('DevToolsActivePort never became ready');
}

function buildArgs(cfg: FpConfig, userDataDir: string): string[] {
  const args: string[] = [
    // 缺省 0：由内核原子分配端口，消除「预分配→close→spawn」窗口内被抢占的竞争；
    // 显式 port（联调/外部连接）照常透传，实际端口一律从 DevToolsActivePort 读回，
    // 因此两种情况都不会连错浏览器（ws 路径含本进程 uuid）。
    `--remote-debugging-port=${cfg.port ?? 0}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    `--fingerprint=${cfg.seed}`,
    `--fingerprint-platform=${cfg.platform}`,
    `--fingerprint-hardware-concurrency=${cfg.hardwareConcurrency}`,
    `--accept-lang=${cfg.acceptLanguage}`,
    `--lang=${cfg.locale}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
  ];
  if (cfg.timezone) args.push(`--timezone=${cfg.timezone}`);
  if (cfg.platformVersion) args.push(`--fingerprint-platform-version=${cfg.platformVersion}`);
  if (cfg.brand && cfg.brandOverride) args.push(`--fingerprint-brand=${cfg.brand}`);
  if (cfg.gpuVendor) args.push(`--fingerprint-gpu-vendor=${cfg.gpuVendor}`);
  if (cfg.gpuRenderer) args.push(`--fingerprint-gpu-renderer=${cfg.gpuRenderer}`);
  if (cfg.deviceScaleFactor) {
    args.push(`--fingerprint-device-scale-factor=${cfg.deviceScaleFactor}`);
  }
  if (cfg.proxy) {
    args.push(`--proxy-server=${typeof cfg.proxy === 'string' ? cfg.proxy : cfg.proxy.server}`);
  }
  if (cfg.headless) args.push('--headless=new');
  if (Array.isArray(cfg.extraArgs)) args.push(...cfg.extraArgs);
  return args;
}

export class FingerprintBrowser {
  private sessions = new Map<string, Session>();
  // 一旦无沙箱降级启动成功(如 Ubuntu 24.04+ AppArmor 限制 userns 导致沙箱不可用),
  // 记住结论:后续启动直接带参数,不再每次白等一轮端点超时。
  private noSandboxRequired = false;
  private sandboxFallbackProfiles = new Set<string>();
  /** Registered immediately after spawn so shutdown can also reach a browser still starting. */
  private processes = new Map<string, ChildProcess>();

  async launch(profileId: string, userConfig: FpUserConfig = {}): Promise<FpHandle> {
    if (this.processes.has(profileId) || this.sessions.has(profileId)) {
      throw new Error(`profile already running: ${profileId}`);
    }

    const exe = await resolveExecutable(userConfig.executablePath);
    // seed 的派生与合法性对齐都在 resolveConfig -> pickSeed 内完成。
    const cfg = resolveConfig(profileId, userConfig);

    const userDataDir = cfg.userDataDir;
    if (!userDataDir) {
      throw new Error(
        `fp launch(${profileId}): config.userDataDir is required (piskie chrome-data path)`,
      );
    }
    mkdirSync(userDataDir, { recursive: true });
    rmSync(join(userDataDir, 'DevToolsActivePort'), { force: true });

    const args = buildArgs(cfg, userDataDir);
    const isSandboxFallback =
      this.noSandboxRequired || this.sandboxFallbackProfiles.has(profileId);
    if (isSandboxFallback) args.push('--no-sandbox', '--disable-setuid-sandbox');
    const proc = spawn(exe, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    this.processes.set(profileId, proc);
    let startupDiagnostic = '';
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      startupDiagnostic = (startupDiagnostic + String(chunk)).slice(-STARTUP_DIAGNOSTIC_LIMIT);
    });

    let control: CdpControl | undefined;
    let rejectStartup!: (error: Error) => void;
    const startupFailure = new Promise<never>((_, reject) => {
      rejectStartup = reject;
    });
    const onSpawnError = (error: Error) => rejectStartup(error);
    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      rejectStartup(
        new Error(
          `fingerprint-chromium exited before DevTools was ready (code=${code}, signal=${signal})`,
        ),
      );
    };
    proc.once('error', onSpawnError);
    proc.once('exit', onEarlyExit);

    try {
      const ws = await Promise.race([
        getDevToolsEndpoint(userDataDir),
        startupFailure,
      ]);
      proc.off('error', onSpawnError);
      proc.off('exit', onEarlyExit);

      control = new CdpControl(ws, cfg);
      await control.connect();

      const session: Session = { control };
      this.sessions.set(profileId, session);

      proc.once('error', (error) => {
        console.error(`[fp-browser] ${profileId}: process error`, error);
      });
      proc.once('exit', () => {
        if (this.sessions.get(profileId) === session) {
          try {
            session.control.close();
          } catch {
            // ignore
          }
          this.sessions.delete(profileId);
        }
        if (this.processes.get(profileId) === proc) this.processes.delete(profileId);
      });

      return {
        seed: cfg.seed,
        config: cfg,
        browserWSEndpoint: ws,
      };
    } catch (error) {
      proc.off('error', onSpawnError);
      proc.off('exit', onEarlyExit);
      try {
        control?.close();
      } catch {
        // ignore
      }
      this.killTree(proc);
      const exited = await this.waitForExit(proc);
      if (exited) {
        if (this.processes.get(profileId) === proc) this.processes.delete(profileId);
      } else {
        proc.once('exit', () => {
          if (this.processes.get(profileId) === proc) this.processes.delete(profileId);
        });
      }
      this.sessions.delete(profileId);

      await waitForDiagnosticDrain(proc);
      const diagnostic = `${error instanceof Error ? error.message : String(error)}\n${startupDiagnostic}`;
      if (
        !isSandboxFallback &&
        exited &&
        process.platform === 'linux' &&
        isKnownSandboxFailure(diagnostic)
      ) {
        console.warn(
          `[fp-browser] ${profileId}: 检测到 Chromium sandbox/userns 启动失败,` +
            `改用 --no-sandbox 降级重试;本进程后续启动将直接使用无沙箱模式`
        );
        this.sandboxFallbackProfiles.add(profileId);
        try {
          await sleep(300); // 让首次进程的 profile 锁释放
          const result = await this.launch(profileId, userConfig);
          this.noSandboxRequired = true;
          return result;
        } finally {
          this.sandboxFallbackProfiles.delete(profileId);
        }
      }
      throw error;
    }
  }


  async stop(profileId: string): Promise<boolean> {
    const proc = this.processes.get(profileId);
    const session = this.sessions.get(profileId);
    if (!proc && !session) return false;

    try {
      session?.control.close();
    } catch {
      // ignore
    }
    let exited = true;
    if (proc) {
      this.killTree(proc);
      exited = await this.waitForExit(proc);
    }
    if (!session || this.sessions.get(profileId) === session) this.sessions.delete(profileId);
    if ((!proc || exited) && this.processes.get(profileId) === proc) {
      this.processes.delete(profileId);
    }
    await sleep(300);
    return true;
  }

  has(profileId: string): boolean {
    return this.processes.has(profileId) || this.sessions.has(profileId);
  }

  getPid(profileId: string): number | undefined {
    return this.processes.get(profileId)?.pid;
  }

  private waitForExit(proc: ChildProcess): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Best-effort process-tree shutdown; callers retain the original lifecycle semantics. */
  private killTree(proc: ChildProcess): void {
    const pid = proc.pid;
    if (!pid || proc.exitCode !== null || proc.signalCode !== null) return;
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 3000,
        });
        return;
      } catch {
        // Fall back to the process handle.
      }
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
        return;
      } catch {
        // Fall back to the process handle.
      }
    }
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

function isKnownSandboxFailure(diagnostic: string): boolean {
  return [
    /no usable sandbox/i,
    /running as root without --no-sandbox/i,
    /suid sandbox helper binary.*not configured correctly/i,
    /failed to move to new namespace.*operation not permitted/i,
    /failed to unshare.*operation not permitted/i,
    /user namespaces?.*(?:disabled|not supported|operation not permitted)/i,
    /namespace sandbox.*(?:failed|unavailable)/i,
  ].some((pattern) => pattern.test(diagnostic));
}

async function waitForDiagnosticDrain(proc: ChildProcess): Promise<void> {
  const stderr = proc.stderr;
  if (!stderr || stderr.destroyed || stderr.readableEnded) return;
  await Promise.race([
    new Promise<void>((resolve) => {
      stderr.once('end', resolve);
      stderr.once('close', resolve);
    }),
    sleep(100),
  ]);
}
