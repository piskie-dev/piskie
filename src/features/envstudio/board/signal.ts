/** EnvStudio · 环境状态语义助手（moodOf/lastUsedLine，拆出组件文件以满足 fast-refresh） */

import type { BrowserEnvironment } from '@shared/types';
import type { DotMood } from '../glyphs/GlowDot';

type TimeTranslator = (key: string, values?: Record<string, number>) => string;

export function moodOf(env: BrowserEnvironment): DotMood {
  if (env.status !== 'running') return 'idle';
  return env.restartRequired ? 'hold' : 'live';
}

/** 预监角标用的紧凑时间戳 */
export function lastUsedStamp(env: BrowserEnvironment, translate: TimeTranslator): string {
  if (!env.lastUsedAt) return translate('environmentUi.time.neverUsedShort');
  const diff = Date.now() - env.lastUsedAt;
  if (diff < 3_600_000) return translate('environmentUi.time.justUsedShort');
  if (diff < 86_400_000) {
    return translate('environmentUi.time.hoursAgoShort', { count: Math.floor(diff / 3_600_000) });
  }
  return translate('environmentUi.time.daysAgoShort', { count: Math.floor(diff / 86_400_000) });
}

/** 运行时长计时器 HH:MM:SS（运行态 HUD 用；lastUsedAt 在启动时刷新，近似开播时刻） */
export function uptimeLine(env: BrowserEnvironment, now: number): string {
  const total = env.lastUsedAt ? Math.max(0, Math.floor((now - env.lastUsedAt) / 1000)) : 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

export function lastUsedLine(env: BrowserEnvironment, translate: TimeTranslator): string {
  if (!env.lastUsedAt) return translate('environmentUi.time.neverUsed');
  const diff = Date.now() - env.lastUsedAt;
  if (diff < 60_000) return translate('environmentUi.time.justUsed');
  if (diff < 3_600_000) {
    return translate('environmentUi.time.minutesAgo', { count: Math.floor(diff / 60_000) });
  }
  if (diff < 86_400_000) {
    return translate('environmentUi.time.hoursAgo', { count: Math.floor(diff / 3_600_000) });
  }
  return translate('environmentUi.time.daysAgo', { count: Math.floor(diff / 86_400_000) });
}
