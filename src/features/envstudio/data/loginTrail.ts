/**
 * EnvStudio 数据层 · 登录痕迹
 *
 * 在环境运行期间采集一次 Cookie 域名清单并缓存到 localStorage。
 * 只接收和持久化域名与数量，不把 Cookie 值暴露给渲染进程。
 */

import { useEffect, useMemo, useState } from 'react';
import type { BrowserEnvironment } from '@shared/types';

export interface TrailSite {
  host: string;
  jar: number;
}

export interface LoginTrail {
  sites: TrailSite[];
  capturedAt: number;
}

const STORE_PREFIX = 'envstudio.trail.';
const CAPTURE_DELAY_MS = 4_000;

function readTrail(envId: string): LoginTrail | null {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + envId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LoginTrail;
    return Array.isArray(parsed.sites) ? parsed : null;
  } catch {
    return null;
  }
}

function writeTrail(envId: string, trail: LoginTrail): void {
  try {
    localStorage.setItem(STORE_PREFIX + envId, JSON.stringify(trail));
  } catch {
    /* 存储满/隐私模式：放弃缓存即可 */
  }
}

/** 运行中自动采集（启动 4s 后取一次），空闲时返回上次运行的缓存 */
export function useLoginTrail(env: BrowserEnvironment): LoginTrail | null {
  const cached = useMemo(() => readTrail(env.id), [env.id]);
  const [fresh, setFresh] = useState<Record<string, LoginTrail>>({});
  const running = env.status === 'running' && !!env.currentBrowserId;

  useEffect(() => {
    if (!running) return;
    let disposed = false;
    const timer = window.setTimeout(async () => {
      try {
        const sites = await window.piskie.pilot.environments.captureLoginTrail(env.id);
        if (disposed) return;
        const next = { sites, capturedAt: Date.now() };
        writeTrail(env.id, next);
        setFresh((previous) => ({ ...previous, [env.id]: next }));
      } catch {
        /* 启动初期浏览器可能未就绪；下次运行再采 */
      }
    }, CAPTURE_DELAY_MS);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [env.id, running]);

  return fresh[env.id] ?? cached;
}
