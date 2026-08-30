/**
 * useCaptureSize —— 按显示区域的**设备像素**决定采集分辨率。
 *
 * 为什么需要它：CDP screencast 的 `maxWidth/maxHeight` 是采集侧的缩放上限。
 * 采集尺寸小于显示尺寸时，画面必须被放大才能铺满面板——这是"糊"的根因，
 * 且再高的 JPEG 质量也救不回来（信息在采集端就没了）。所以采集尺寸要跟着
 * 面板的设备像素走：面板越大、屏幕 DPR 越高，就采得越大。
 *
 * 两道防抖，缺一不可（拖分栏条时体感差别很大）：
 * 1. **量化到 64px 台阶**——逐像素上报会让参数一直在变；向上取整保证永不欠采。
 * 2. **沉降延迟**——拖动是连续过程，跨越多个台阶就会多次重设参数，而每次重设
 *    都是一次 `Page.stopScreencast` + `startScreencast`（CDP 没有"改参数"命令），
 *    表现为拖动时画面一卡一卡。因此拖动期间只记不发，停手 `SETTLE_MS` 后才提交
 *    一次。拖动中画面由 CSS 继续缩放显示（略软但不断流），停手后变清晰。
 *
 * 首次测量不等沉降（立即提交），否则首帧要晚 250ms 才有正确分辨率。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ScreenCaptureOptions } from '@/domains/screen-feed/worker-protocol';

/** JPEG 质量：文字页面在 80 上有肉眼可见的振铃，90 基本消失（体积约 1.6×，本地 IPC 无压力） */
const CAPTURE_QUALITY = 90;

/** 量化台阶（设备像素） */
const STEP = 64;

/**
 * 尺寸停止变化后多久才提交（ms）。250 是"松手即响应"与"拖动中不抖"的折中：
 * 明显短于人对延迟的容忍阈（~300ms），又长于拖动时两帧 resize 的间隔。
 */
const SETTLE_MS = 250;

/** 上限与 hub 侧一致；此处先夹一次，省得每次 resize 都推超限值过去 */
const MAX_WIDTH = 2560;
const MAX_HEIGHT = 1440;

const quantize = (value: number, max: number): number =>
  Math.min(max, Math.max(STEP, Math.ceil(value / STEP) * STEP));

/**
 * 返回 [ref 回调, 采集参数]。把 ref 挂到**显示区域**元素（canvas 的容器）上。
 * 元素未挂载或尺寸为 0 时返回 undefined —— 由 hub 侧默认值兜底。
 */
export function useCaptureSize(): [
  (node: HTMLElement | null) => void,
  ScreenCaptureOptions | undefined,
] {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  /** 已提交过一次 ⇒ 后续变化都要等沉降；首次立即提交 */
  const committedRef = useRef(false);

  // 卸载时清掉待触发的沉降定时器（否则会在已卸载的组件上 setState）
  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    },
    [],
  );

  const ref = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // devicePixelContentBoxSize 是真设备像素（含 DPR，跨屏搬窗口也会重新触发）；
      // 拿不到时退回 CSS 尺寸 × DPR
      const devicePixelBox = entry.devicePixelContentBoxSize?.[0];
      const width = devicePixelBox
        ? devicePixelBox.inlineSize
        : entry.contentRect.width * (window.devicePixelRatio || 1);
      const height = devicePixelBox
        ? devicePixelBox.blockSize
        : entry.contentRect.height * (window.devicePixelRatio || 1);
      if (width <= 0 || height <= 0) return;
      const next = { width: quantize(width, MAX_WIDTH), height: quantize(height, MAX_HEIGHT) };

      const commit = () => {
        committedRef.current = true;
        setSize((previous) =>
          previous && previous.width === next.width && previous.height === next.height
            ? previous
            : next,
        );
      };

      if (!committedRef.current) {
        commit();
        return;
      }

      // 拖动期间只重排定时器，不提交；停手后一次到位
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        commit();
      }, SETTLE_MS);
    });
    // box: 'device-pixel-content-box' 才会填充 devicePixelContentBoxSize
    try {
      observer.observe(node, { box: 'device-pixel-content-box' });
    } catch {
      observer.observe(node);
    }
    observerRef.current = observer;
  }, []);

  const capture = useMemo<ScreenCaptureOptions | undefined>(
    () =>
      size
        ? { quality: CAPTURE_QUALITY, maxWidth: size.width, maxHeight: size.height }
        : undefined,
    [size],
  );

  return [ref, capture];
}
