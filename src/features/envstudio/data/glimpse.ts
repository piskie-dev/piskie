/**
 * EnvStudio 数据层 · 实时画面
 *
 * 对运行中环境轮询既有 `pilot.screen.snapshot(browserId)`（CDP JPEG 单帧），
 * 转成 blob URL 给 <img> 消费。规则：
 * - 仅 running 且携带 currentBrowserId 的环境入池；
 * - 页面不可见（document.hidden）暂停；
 * - 连续 3 次失败退避到 10s 并标记 stale；
 * - 旧 blob URL 用后即 revoke，防内存泄漏。
 */

import { useEffect, useRef, useState } from 'react';

const BACKOFF_AFTER = 3;
const BACKOFF_MS = 10_000;
/** 快照 JPEG 质量（0-100）：缩略用途，压低省带宽 */
const GLIMPSE_QUALITY = 55;

/** 取帧遥测：主屏 HUD 消费（帧率为实测到帧节奏的滑动均值） */
export interface GlimpsePulse {
  /** 实际到帧频率（EMA，snapshot 轮询口径） */
  fps: number;
  /** 最新一帧 JPEG 体积（KB） */
  frameKb: number;
  /** 最新一次取帧耗时（ms，含 IPC + CDP 截图） */
  grabMs: number;
}

export interface Glimpse {
  /** blob URL；尚无帧时为 null */
  src: string | null;
  /** 连续失败中（画面可能过期） */
  stale: boolean;
  /** 遥测；尚无成帧时为 null */
  pulse: GlimpsePulse | null;
}

export function useGlimpse(
  browserId: string | undefined,
  intervalMs: number,
  /** 进入过期态的边沿回调（每个失联周期只触发一次）——上层用来核对环境是否已在别处停止 */
  onLapse?: () => void,
): Glimpse {
  const [src, setSrc] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [pulse, setPulse] = useState<GlimpsePulse | null>(null);
  const urlRef = useRef<string | null>(null);
  // 回调走 ref，避免其身份变化重启轮询循环
  const onLapseRef = useRef(onLapse);
  useEffect(() => {
    onLapseRef.current = onLapse;
  }, [onLapse]);

  useEffect(() => {
    if (!browserId) {
      // 资源清理即可；可见值由返回处按 browserId 掩码，不在 effect 里同步 setState
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      return;
    }

    let disposed = false;
    let timer: number | null = null;
    let failures = 0;
    let lastFrameAt = 0;
    let fpsEma = 0;

    const swap = (url: string) => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setSrc(url);
    };

    const tick = async () => {
      if (disposed) return;
      if (document.hidden) {
        schedule(intervalMs);
        return;
      }
      try {
        const grabStart = performance.now();
        const frame = await window.piskie.pilot.screen.snapshot(browserId, GLIMPSE_QUALITY);
        if (disposed) return;
        const grabEnd = performance.now();
        // 到帧节奏 EMA：首帧以名义节拍起步，之后按实际帧距平滑
        if (lastFrameAt > 0) {
          const instant = 1000 / Math.max(1, grabEnd - lastFrameAt);
          fpsEma = fpsEma === 0 ? instant : fpsEma * 0.7 + instant * 0.3;
        } else {
          fpsEma = 1000 / intervalMs;
        }
        lastFrameAt = grabEnd;
        setPulse({
          fps: fpsEma,
          frameKb: frame.data.byteLength / 1024,
          grabMs: grabEnd - grabStart,
        });
        // 拷贝到独立 ArrayBuffer（源可能是共享/偏移视图，Blob 不收）
        const blob = new Blob([new Uint8Array(frame.data)], { type: 'image/jpeg' });
        swap(URL.createObjectURL(blob));
        failures = 0;
        setStale(false);
        schedule(intervalMs);
      } catch {
        if (disposed) return;
        failures += 1;
        if (failures >= BACKOFF_AFTER) setStale(true);
        // 恰好跨过判死线的那一次：通知上层核对环境状态（环境可能已在别处停止）
        if (failures === BACKOFF_AFTER) onLapseRef.current?.();
        schedule(failures >= BACKOFF_AFTER ? BACKOFF_MS : intervalMs);
      }
    };

    const schedule = (delay: number) => {
      if (disposed) return;
      timer = window.setTimeout(() => void tick(), delay);
    };

    const onVisible = () => {
      if (!document.hidden && timer === null) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    void tick();

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [browserId, intervalMs]);

  return browserId ? { src, stale, pulse } : { src: null, stale: false, pulse: null };
}
