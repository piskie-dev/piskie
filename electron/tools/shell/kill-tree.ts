import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';

const POSIX_SIGKILL_GRACE_MS = 1_000;
const WINDOWS_TASKKILL_DEADLINE_MS = 2_000;
const WINDOWS_FALLBACK_DEADLINE_MS = 1_500;

export interface TreeKiller {
  kill(): void;
  readonly initiated: boolean;
  readonly treeKillFailed: boolean;
  onParentClose(): void;
  dispose(): void;
}

/** Bounded, idempotent process-tree termination for shell and ripgrep. */
export function createTreeKiller(
  child: ChildProcess,
  options: { onWindowsFallbackDeadline: () => void },
): TreeKiller {
  const isWindows = os.platform() === 'win32';
  let initiated = false;
  let treeKillFailed = false;
  let disposed = false;
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let taskkillTimer: ReturnType<typeof setTimeout> | undefined;

  const fallbackWindowsKill = (): void => {
    if (disposed || treeKillFailed) return;
    treeKillFailed = true;
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
    fallbackTimer = setTimeout(() => {
      if (!disposed) options.onWindowsFallbackDeadline();
    }, WINDOWS_FALLBACK_DEADLINE_MS);
  };

  const kill = (): void => {
    if (initiated || disposed) return;
    initiated = true;
    if (child.pid == null) return;

    if (isWindows) {
      try {
        const taskkill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
        });
        taskkillTimer = setTimeout(() => {
          try { taskkill.kill('SIGKILL'); } catch { /* already exited */ }
          fallbackWindowsKill();
        }, WINDOWS_TASKKILL_DEADLINE_MS);
        taskkill.on('exit', (code) => {
          if (taskkillTimer) clearTimeout(taskkillTimer);
          if (code !== 0) fallbackWindowsKill();
        });
        taskkill.on('error', fallbackWindowsKill);
      } catch {
        fallbackWindowsKill();
      }
      return;
    }

    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* process group exited */ }
    sigkillTimer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* process group exited */ }
    }, POSIX_SIGKILL_GRACE_MS);
  };

  const onParentClose = (): void => {
    if (isWindows || !initiated || child.pid == null) return;
    try {
      process.kill(-child.pid, 0);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group exited after probe */ }
    } catch { /* process group exited */ }
  };

  const dispose = (): void => {
    disposed = true;
    if (sigkillTimer) clearTimeout(sigkillTimer);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    if (taskkillTimer) clearTimeout(taskkillTimer);
  };

  return {
    kill,
    onParentClose,
    dispose,
    get initiated() { return initiated; },
    get treeKillFailed() { return treeKillFailed; },
  };
}
