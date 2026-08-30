/**
 * Window Controller - 跨平台浏览器窗口焦点切换
 *
 * show() 激活浏览器窗口；后台启动时内部把焦点切回接入方窗口。
 *
 * 与 BrowserManager 集成，支持：
 * - 通过 browserId 控制窗口焦点切换
 * - 后台启动后把焦点切回调用方窗口
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import debug from 'debug';
import { BrowserManager } from './browser-manager.js';
import type { CallerWindowConfig } from '@shared/types/index.js';

const execAsync = promisify(exec);
const logger = debug('piskiepilot:window-controller');

type Platform = 'win32' | 'darwin' | 'linux';

/**
 * 后台启动后的窗口初始化选项
 */
interface InitializeOptions {
  /** 是否启动时隐藏（激活接入方窗口） */
  startHidden?: boolean;
  /** 接入方窗口配置 */
  callerWindow?: CallerWindowConfig;
}

/**
 * show() 方法的返回结果
 */
interface ShowResult {
  success: boolean;
  error?: string;
  reason?: 'pid_not_found' | 'browser_not_found' | 'platform_unsupported' | 'activation_failed';
  debug?: {
    browserId: string;
    pid?: number;
    platform: Platform;
    instanceExists?: boolean;
    processExists?: boolean;
    persistedConfigExists?: boolean;
    /** 当前所有注册的浏览器 ID（用于诊断） */
    allBrowserIds?: string[];
  };
}

/**
 * 跨平台浏览器窗口焦点切换控制器
 *
 * BrowserManager 在启动后调用 initialize 恢复调用方焦点。
 */
export class WindowController {
  private static platform: Platform = process.platform as Platform;

  /**
   * 激活接入方窗口（焦点切换到调用方）
   *
   * @param browserId 浏览器 ID
   * @returns 是否成功
   */
  private static async activateCallerWindow(
    browserId: string,
    callerWindow: CallerWindowConfig,
  ): Promise<boolean> {
    logger('Activating caller window: browserId=%s, platform=%s', browserId, this.platform);
    logger('Caller window config: %O', callerWindow);

    try {
      let success = false;

      switch (this.platform) {
        case 'win32':
          if (callerWindow.hwnd) {
            success = await this.activateWindowsHwnd(callerWindow.hwnd);
          } else {
            logger('Windows requires hwnd in callerWindow config');
          }
          break;

        case 'darwin':
          if (callerWindow.bundleId) {
            success = await this.activateMacByBundleId(callerWindow.bundleId);
          } else if (callerWindow.pid) {
            success = await this.activateMacByPid(callerWindow.pid);
          } else {
            logger('macOS requires bundleId or pid in callerWindow config');
          }
          break;

        case 'linux':
          if (callerWindow.windowId) {
            success = await this.activateLinuxWindow(callerWindow.windowId);
          } else {
            logger('Linux requires windowId in callerWindow config');
          }
          break;

        default:
          logger('Unsupported platform: %s', this.platform);
          return false;
      }

      if (success) {
        logger('Caller window activated');
      }

      return success;
    } catch (error) {
      logger('Failed to activate caller window: %O', error);
      return false;
    }
  }

  /**
   * 激活浏览器窗口（焦点切换到浏览器）
   *
   * @param browserId 浏览器 ID
   * @returns ShowResult 包含成功状态和诊断信息
   */
  static async show(browserId: string): Promise<ShowResult> {
    // 收集诊断信息
    const debugInfo = await BrowserManager.getDebugInfo(browserId);
    const debug: ShowResult['debug'] = {
      browserId,
      platform: this.platform,
      instanceExists: debugInfo.instanceExists,
      processExists: debugInfo.processExists,
      persistedConfigExists: debugInfo.persistedConfigExists,
      pid: debugInfo.processPid || debugInfo.persistedPid,
      allBrowserIds: debugInfo.allBrowserIds
    };

    // 详细日志，用于诊断多浏览器实例问题
    logger('=== SHOW DEBUG === browserId=%s, debugInfo=%O', browserId, {
      instanceExists: debugInfo.instanceExists,
      processExists: debugInfo.processExists,
      processPid: debugInfo.processPid,
      persistedConfigExists: debugInfo.persistedConfigExists,
      persistedPid: debugInfo.persistedPid,
      allBrowserIds: debugInfo.allBrowserIds,
      finalPid: debug.pid
    });

    const pid = debug.pid;

    if (!pid) {
      const error = `Browser ${browserId}: PID not found`;
      logger('Cannot show: %s, debug=%O', error, debug);
      return {
        success: false,
        error,
        reason: debug.instanceExists ? 'pid_not_found' : 'browser_not_found',
        debug
      };
    }

    logger('=== SHOW START === browserId=%s, pid=%s, platform=%s', browserId, pid, this.platform);

    try {
      let success = false;

      switch (this.platform) {
        case 'win32':
          success = await this.activateBrowserWindows(pid);
          break;
        case 'darwin':
          success = await this.activateBrowserMac(pid);
          break;
        case 'linux':
          success = await this.activateBrowserLinux(pid);
          break;
        default:
          logger('Unsupported platform: %s', this.platform);
          return {
            success: false,
            error: `Unsupported platform: ${this.platform}`,
            reason: 'platform_unsupported',
            debug: { browserId, pid, platform: this.platform }
          };
      }

      if (success) {
        logger('=== SHOW END === success, browser window activated');
        return { success: true, debug };
      } else {
        const error = `Failed to activate window for PID ${pid}`;
        logger('=== SHOW END === failed: %s', error);
        return {
          success: false,
          error,
          reason: 'activation_failed',
          debug
        };
      }
    } catch (error) {
      logger('Failed to activate browser window: %O', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        reason: 'activation_failed',
        debug
      };
    }
  }

  /**
   * BrowserManager 后台启动浏览器后恢复调用方焦点。
   *
   * @param browserId 浏览器 ID
   * @param options 初始化选项
   */
  static async initialize(browserId: string, options?: InitializeOptions): Promise<void> {
    const { startHidden = false, callerWindow } = options || {};

    if (startHidden && callerWindow) {
      // 等待窗口创建完成
      await new Promise(r => setTimeout(r, 500));
      await this.activateCallerWindow(browserId, callerWindow);
    }

    logger(
      'Window focus initialized for %s (hidden: %s, callerWindow: %s)',
      browserId,
      startHidden,
      callerWindow ? 'configured' : 'not configured'
    );
  }

  // ==================== Windows 实现 ====================

  /**
   * 执行 PowerShell 命令（隐藏控制台窗口）
   */
  private static runPowerShell(encodedCommand: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', [
        '-WindowStyle', 'Hidden',
        '-NoProfile',
        '-EncodedCommand', encodedCommand
      ], {
        windowsHide: true,  // 关键：隐藏控制台窗口
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      ps.stdout?.on('data', (data) => { stdout += data.toString(); });
      ps.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`PowerShell exited with code ${code}`));
      });
      ps.on('error', reject);
    });
  }

  /**
   * 激活浏览器窗口 (Windows)
   */
  private static async activateBrowserWindows(pid: number): Promise<boolean> {
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class Win32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    public const int SW_RESTORE = 9;
    public const int ASFW_ANY = -1;
    public static List<IntPtr> GetProcessWindows(uint targetPid) {
        var windows = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (processId == targetPid && IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0) {
                windows.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return windows;
    }
}
"@
$windows = [Win32]::GetProcessWindows(${pid})
if ($windows.Count -eq 0) {
    $p = Get-Process -Id ${pid} -EA 0
    if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
        $windows = @($p.MainWindowHandle)
    }
}
if ($windows.Count -gt 0) {
    $targetHwnd = $windows[0]
    $foregroundWindow = [Win32]::GetForegroundWindow()
    $foregroundThread = [Win32]::GetWindowThreadProcessId($foregroundWindow, [ref]$null)
    $currentThread = [Win32]::GetCurrentThreadId()
    $attached = [Win32]::AttachThreadInput($currentThread, $foregroundThread, $true)
    try {
        [Win32]::AllowSetForegroundWindow([Win32]::ASFW_ANY)
        # 只有最小化时才需要 SW_RESTORE，避免改变最大化/正常窗口的大小
        if ([Win32]::IsIconic($targetHwnd)) {
            [Win32]::ShowWindow($targetHwnd, [Win32]::SW_RESTORE)
        }
        [Win32]::BringWindowToTop($targetHwnd)
        [Win32]::SetForegroundWindow($targetHwnd)
        'OK'
    } finally {
        if ($attached) {
            [Win32]::AttachThreadInput($currentThread, $foregroundThread, $false)
        }
    }
} else {
    'NO_WINDOW'
}
`;
    // 使用 Base64 编码避免命令行转义问题
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    try {
      const stdout = await this.runPowerShell(encoded);
      return stdout.includes('OK');
    } catch (error) {
      logger('Windows activate browser failed: %O', error);
      return false;
    }
  }

  /**
   * 激活接入方窗口 (Windows) - 通过窗口句柄
   */
  private static async activateWindowsHwnd(hwnd: number): Promise<boolean> {
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    public const int SW_RESTORE = 9;
    public const int ASFW_ANY = -1;
}
"@
$targetHwnd = [IntPtr]${hwnd}
$foregroundWindow = [Win32]::GetForegroundWindow()
$foregroundThread = [Win32]::GetWindowThreadProcessId($foregroundWindow, [IntPtr]::Zero)
$currentThread = [Win32]::GetCurrentThreadId()
$attached = [Win32]::AttachThreadInput($currentThread, $foregroundThread, $true)
try {
    [Win32]::AllowSetForegroundWindow([Win32]::ASFW_ANY)
    # 只有最小化时才需要 SW_RESTORE，避免改变最大化/正常窗口的大小
    if ([Win32]::IsIconic($targetHwnd)) {
        [Win32]::ShowWindow($targetHwnd, [Win32]::SW_RESTORE)
    }
    [Win32]::BringWindowToTop($targetHwnd)
    [Win32]::SetForegroundWindow($targetHwnd)
    'OK'
} finally {
    if ($attached) {
        [Win32]::AttachThreadInput($currentThread, $foregroundThread, $false)
    }
}
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    try {
      const stdout = await this.runPowerShell(encoded);
      return stdout.includes('OK');
    } catch (error) {
      logger('Windows activate hwnd failed: %O', error);
      return false;
    }
  }

  // ==================== macOS 实现 ====================

  /**
   * 激活浏览器窗口 (macOS)
   *
   * 通过 PID 精确定位到指定的 Chrome 进程，并激活其窗口。
   *
   * 重要：必须分两步执行 AXRaise 和 set frontmost，否则在多 Chrome 实例场景下
   * 会激活错误的窗口。这是 macOS System Events 的已知行为。
   */
  private static async activateBrowserMac(pid: number): Promise<boolean> {
    try {
      // 第1步：AXRaise 激活指定进程的窗口
      const raiseScript = `tell application "System Events" to tell (first process whose unix id is ${pid}) to perform action "AXRaise" of window 1`;
      await execAsync(`osascript -e '${raiseScript}'`);

      // 第2步：将进程设为前台（必须分开执行，否则多实例场景下会激活错误窗口）
      const frontmostScript = `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`;
      await execAsync(`osascript -e '${frontmostScript}'`);

      logger('macOS activate result: pid=%d, success', pid);
      return true;
    } catch (error) {
      logger('macOS activate browser failed: %O', error);
      return false;
    }
  }

  /**
   * 激活接入方窗口 (macOS) - 通过进程 ID
   *
   * 使用 AXRaise 确保激活该进程的窗口，支持多窗口场景。
   */
  private static async activateMacByPid(pid: number): Promise<boolean> {
    try {
      const script = `
        tell application "System Events"
          set targetProcess to first process whose unix id is ${pid}
          tell targetProcess
            if (count of windows) > 0 then
              perform action "AXRaise" of window 1
            end if
          end tell
          set frontmost of targetProcess to true
        end tell
      `;
      await execAsync(`osascript -e '${script}'`);
      return true;
    } catch (error) {
      logger('macOS activate by pid failed: %O', error);
      return false;
    }
  }

  /**
   * 激活接入方窗口 (macOS) - 通过 Bundle ID
   */
  private static async activateMacByBundleId(bundleId: string): Promise<boolean> {
    try {
      const script = `tell application id "${bundleId}" to activate`;
      await execAsync(`osascript -e '${script}'`);
      return true;
    } catch (error) {
      logger('macOS activate by bundleId failed: %O', error);
      return false;
    }
  }

  // ==================== Linux 实现 ====================

  /** 缓存 wmctrl 可用性检查结果 */
  private static wmctrlAvailable: boolean | null = null;

  /**
   * 检查 wmctrl 是否可用（带缓存）
   */
  private static async isWmctrlAvailable(): Promise<boolean> {
    if (this.wmctrlAvailable !== null) {
      return this.wmctrlAvailable;
    }

    try {
      await execAsync('which wmctrl');
      this.wmctrlAvailable = true;
      logger('wmctrl is available');
    } catch {
      this.wmctrlAvailable = false;
      logger('wmctrl not found');
    }

    return this.wmctrlAvailable;
  }

  /**
   * 激活浏览器窗口 (Linux)
   */
  private static async activateBrowserLinux(pid: number): Promise<boolean> {
    if (!await this.isWmctrlAvailable()) {
      logger('wmctrl not available, cannot activate browser window');
      return false;
    }

    try {
      const windowId = await this.getLinuxWindowId(pid);
      if (windowId) {
        await execAsync(`wmctrl -i -a ${windowId}`);
        logger('Linux browser window activated: %s', windowId);
        return true;
      }
    } catch (error) {
      logger('Linux activate browser failed: %O', error);
    }

    return false;
  }

  /**
   * 激活接入方窗口 (Linux) - 通过窗口 ID
   */
  private static async activateLinuxWindow(windowId: string): Promise<boolean> {
    if (!await this.isWmctrlAvailable()) {
      logger('wmctrl not available, cannot activate window');
      return false;
    }

    try {
      await execAsync(`wmctrl -i -a ${windowId}`);
      logger('Linux caller window activated: %s', windowId);
      return true;
    } catch (error) {
      logger('Linux activate window failed: %O', error);
      return false;
    }
  }

  /**
   * 获取 Linux 窗口 ID（使用 wmctrl）
   */
  private static async getLinuxWindowId(pid: number): Promise<string | null> {
    try {
      const { stdout } = await execAsync('wmctrl -lp');
      const lines = stdout.split('\n');
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 3 && parts[2] === String(pid)) {
          logger('Found window ID %s for PID %d', parts[0], pid);
          return parts[0];
        }
      }
    } catch (error) {
      logger('wmctrl search failed: %O', error);
    }

    return null;
  }

}
