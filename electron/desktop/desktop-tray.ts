/**
 * 系统托盘 / macOS 菜单栏图标，用于窗口关闭后继续在后台运行。
 *
 * 关闭窗口后应用退到这里:单击直接呼起主窗口;macOS 图标旁显示活遥测
 * (token/s 速率 + 总消耗,Clash 式双行),Windows/Linux 同信息进 tooltip。
 * 「退出」只在托盘菜单与 Cmd+Q:仍走 DesktopRuntime 的事务停机,不抄近路。
 *
 * 两个遥测两种口径(2026-08-24 裁决):
 * - 速率 = 各在跑会话(含子代理)**纯输出生成吞吐**之和(输出 token ÷ 生成时长,
 *   与控制台底栏的 tok/s 同一算法),空闲归零;
 * - 总消耗(tooltip)= 输入+输出全量,与天际栏同源的纯加法账本:差量吸收
 *   runMetrics、单调不减、离场不回落、恢复重计不重复;主进程内存态,不持久化。
 */

import { execFileSync } from 'node:child_process';
import { Menu, Tray, nativeImage, nativeTheme } from 'electron';
import { canPause, type AgentControlState } from '../../shared/types/agent-control.js';
import type { AgentObservationSource } from '../agent/observations.js';

export interface DesktopTrayOptions {
  readonly platform: NodeJS.Platform;
  /** 深色系统表面上的浅色 glyph；macOS 只取它的 alpha 通道。 */
  readonly lightGlyphPath: string;
  /** 浅色 Windows 系统表面上的深色 glyph。 */
  readonly darkGlyphPath: string;
  readonly observations: Pick<AgentObservationSource, 'controlStateChanges' | 'runtimeReleases'>;
  readonly onSummon: () => void;
  readonly onQuit: () => void;
}

/** 遥测刷新周期(毫秒) */
const PULSE_INTERVAL_MS = 1000;
const WINDOWS_THEME_REFRESH_DELAY_MS = 100;
const WINDOWS_THEME_QUERY_TIMEOUT_MS = 1000;
const WINDOWS_TRAY_ICON_DIP_SIZE = 16;
const WINDOWS_TRAY_SCALE_FACTORS = [1, 1.25, 1.5, 2] as const;
const WINDOWS_THEME_REGISTRY_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

function windowsSystemSurfaceUsesDarkColors(): boolean {
  try {
    const output = execFileSync('reg.exe', [
      'query',
      WINDOWS_THEME_REGISTRY_KEY,
      '/v',
      'SystemUsesLightTheme',
    ], {
      encoding: 'utf8',
      timeout: WINDOWS_THEME_QUERY_TIMEOUT_MS,
      windowsHide: true,
    });
    const encodedValue = /^\s*SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im
      .exec(output)?.[1];
    if (encodedValue !== undefined) return Number.parseInt(encodedValue, 16) === 0;
  } catch {
    // Fall through when registry access is unavailable.
  }
  // Electron 42 falls back to the application theme before its first native-theme update.
  return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
}

function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(2)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`;
  return String(Math.round(total));
}

/** 与天际栏同源的纯加法账本(主进程侧独立一份,互不依赖) */
class TokenPulse {
  private readonly baselines: Record<string, number> = {};
  total = 0;

  absorb(state: AgentControlState): void {
    this.take(state.agentId, state.runMetrics);
    for (const child of state.children) this.take(child.id, child.runMetrics);
  }

  private take(targetId: string, metrics: { inputTokens: number; outputTokens: number }): void {
    const reading = metrics.inputTokens + metrics.outputTokens;
    const baseline = this.baselines[targetId] ?? 0;
    if (reading > baseline) this.total += reading - baseline;
    this.baselines[targetId] = reading;
  }
}

/** 单个目标的生成吞吐(token/s):与控制台底栏同一算法 */
function throughputOf(metrics: {
  generationOutputTokens: number;
  generationDurationMs: number;
}): number {
  return metrics.generationDurationMs > 0
    ? metrics.generationOutputTokens / (metrics.generationDurationMs / 1000)
    : 0;
}

export class DesktopTray {
  private tray?: Tray;
  private timer?: ReturnType<typeof setInterval>;
  private windowsThemeRefreshTimer?: ReturnType<typeof setTimeout>;
  private readonly releaseObservations: (() => void)[] = [];
  private readonly pulse = new TokenPulse();
  /** 各在跑会话的最新控制状态(速率求和用);runtime 释放即移除 */
  private readonly liveStates = new Map<string, AgentControlState>();

  constructor(private readonly options: DesktopTrayOptions) {}

  start(): void {
    if (this.tray) return;
    const darwin = this.options.platform === 'darwin';
    this.tray = new Tray(this.buildIcon());
    this.tray.setToolTip('piskie');

    const menu = Menu.buildFromTemplate([
      { label: '显示', click: () => this.options.onSummon() },
      { type: 'separator' },
      { label: '退出', click: () => this.options.onQuit() },
    ]);
    if (darwin) {
      // macOS 上 setContextMenu 会吞掉 click 事件,单击呼起与右键菜单只能手工分流
      this.tray.on('click', () => this.options.onSummon());
      this.tray.on('right-click', () => this.tray?.popUpContextMenu(menu));
    } else {
      this.tray.on('click', () => this.options.onSummon());
      this.tray.setContextMenu(menu);
    }
    if (this.options.platform === 'win32') {
      nativeTheme.on('updated', this.scheduleWindowsIconRefresh);
    }

    this.releaseObservations.push(
      this.options.observations.controlStateChanges.subscribe(({ state }) => {
        this.pulse.absorb(state);
        this.liveStates.set(state.agentId, state);
      }),
      this.options.observations.runtimeReleases.subscribe(({ agentId }) => {
        this.liveStates.delete(agentId);
      }),
    );
    this.timer = setInterval(() => this.refreshTelemetry(), PULSE_INTERVAL_MS);
    this.refreshTelemetry();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.windowsThemeRefreshTimer) clearTimeout(this.windowsThemeRefreshTimer);
    this.windowsThemeRefreshTimer = undefined;
    if (this.options.platform === 'win32') {
      nativeTheme.removeListener('updated', this.scheduleWindowsIconRefresh);
    }
    for (const release of this.releaseObservations.splice(0)) release();
    this.tray?.destroy();
    this.tray = undefined;
  }

  private readonly scheduleWindowsIconRefresh = (): void => {
    if (this.windowsThemeRefreshTimer) clearTimeout(this.windowsThemeRefreshTimer);
    this.windowsThemeRefreshTimer = setTimeout(() => {
      this.windowsThemeRefreshTimer = undefined;
      this.tray?.setImage(this.buildWindowsIcon());
    }, WINDOWS_THEME_REFRESH_DELAY_MS);
  };

  /** 在忙会话(含子代理)的生成吞吐求和;没有在忙的即 0 */
  private currentOutputRate(): number {
    let rate = 0;
    for (const state of this.liveStates.values()) {
      if (!canPause(state)) continue;
      rate += throughputOf(state.runMetrics);
      for (const child of state.children) rate += throughputOf(child.runMetrics);
    }
    return rate;
  }

  private refreshTelemetry(): void {
    const tray = this.tray;
    if (!tray) return;
    const rateText = `${formatTokens(this.currentOutputRate())}/s`;
    const totalText = formatTokens(this.pulse.total);
    tray.setToolTip(`piskie · ${rateText} · 总消耗 ${totalText}`);
    if (this.options.platform === 'darwin') {
      // setTitle 无字号控制,双行(\n)会按全尺寸字体溢出菜单栏——单行只放速率,总量进 tooltip
      tray.setTitle(rateText, { fontType: 'monospacedDigit' });
    }
  }

  private buildIcon(): Electron.NativeImage {
    if (this.options.platform === 'darwin') {
      const source = nativeImage.createFromPath(this.options.lightGlyphPath);
      const icon = nativeImage.createEmpty();
      icon.addRepresentation({ scaleFactor: 1, buffer: source.resize({ width: 18, height: 18 }).toPNG() });
      icon.addRepresentation({ scaleFactor: 2, buffer: source.resize({ width: 36, height: 36 }).toPNG() });
      icon.setTemplateImage(true);
      return icon;
    }
    if (this.options.platform === 'win32') return this.buildWindowsIcon();
    return this.buildGlyph(this.options.lightGlyphPath);
  }

  private buildWindowsIcon(): Electron.NativeImage {
    const glyphPath = windowsSystemSurfaceUsesDarkColors()
      ? this.options.lightGlyphPath
      : this.options.darkGlyphPath;
    const source = nativeImage.createFromPath(glyphPath);
    const icon = nativeImage.createEmpty();
    for (const scaleFactor of WINDOWS_TRAY_SCALE_FACTORS) {
      const size = Math.round(WINDOWS_TRAY_ICON_DIP_SIZE * scaleFactor);
      icon.addRepresentation({
        scaleFactor,
        buffer: source.resize({ width: size, height: size, quality: 'best' }).toPNG(),
      });
    }
    return icon;
  }

  private buildGlyph(glyphPath: string): Electron.NativeImage {
    return nativeImage.createFromPath(glyphPath).resize({ width: 16, height: 16 });
  }
}
