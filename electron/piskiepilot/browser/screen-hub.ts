/**
 * ScreenStreamHub — 浏览器屏幕流中枢(进程内)
 *
 * viewer 是 ViewerSink 抽象(MessagePort 适配器由 electron 侧提供,本文件不依赖 electron):
 * - 每 browserId 一个 ScreenCaster(CDP screencast),多 viewer 共享
 * - reconcileFps:caster 帧率取所有 viewer 的最大值
 * - lastFrame 重放:新 viewer 加入立即得到最近一帧
 * - viewer 清零时停 caster
 *
 * 帧发送为单条 { type:'frame', meta, data } 消息(取代旧 meta+binary 两段式);
 * 背压(1-in-flight + latest-wins)由 sink 适配器实现,hub 对每帧只管调 send。
 */

import { ScreenCaster, type ScreencastFrame } from './core/browser/screen-caster.js';
import { BrowserManager } from './core/browser/browser-manager.js';
import type { RemoteInputEvent, StreamServerMessage } from '@shared/types/stream.js';

/** 流下行通道抽象(MessagePort/测试桩均可实现) */
export interface ViewerSink {
  /** 发送服务端消息(帧背压由实现方处理) */
  send(msg: StreamServerMessage): void;
  isOpen(): boolean;
}

export interface ViewerOptions {
  fps?: number;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
}

/** 每个 viewer 的采集诉求；caster 取所有 viewer 的逐项最大值。 */
interface ViewerInfo {
  fps: number;
  quality: number;
  maxWidth: number;
  maxHeight: number;
}

interface CasterEntry {
  caster: ScreenCaster;
  viewers: Map<ViewerSink, ViewerInfo>;
  seq: number;
  lastFrame: ScreencastFrame | null;
  /** 逻辑选中页跟随定时器；停流时清除 */
  follow: ReturnType<typeof setInterval> | null;
}

/** 跟随 selectedPageIdx 的轮询间隔。 */
const FOLLOW_SELECTED_PAGE_MS = 1_000;

/**
 * 未指定时使用 1080p/q88 采集基线；较低的 720p/q80 会让 Retina 面板放大画面，
 * 是显示模糊的主要原因。
 */
const DEFAULT_VIEWER: Omit<ViewerInfo, 'fps'> = {
  quality: 88,
  maxWidth: 1920,
  maxHeight: 1080,
};

/** 采集分辨率硬上限:5K 屏上按设备像素直取会让 JPEG 编码吃满被控浏览器的 CPU */
const MAX_CAPTURE_WIDTH = 2560;
const MAX_CAPTURE_HEIGHT = 1440;

const clampQuality = (value: number): number => Math.min(100, Math.max(1, Math.round(value)));
const clampWidth = (value: number): number =>
  Math.min(MAX_CAPTURE_WIDTH, Math.max(320, Math.round(value)));
const clampHeight = (value: number): number =>
  Math.min(MAX_CAPTURE_HEIGHT, Math.max(240, Math.round(value)));

/**
 * fps → everyNthFrame（CDP 只认"每 N 帧发一帧"，基准 60Hz）。
 * 注意粒度是整数分频：24fps 会取整成 N=3，实际只有 20fps——
 * 想要真 30fps 必须请求 30（N=2）；请求 24fps 实际只得到 20fps，是输入不跟手的原因之一。
 */
const everyNthFrameOf = (fps: number): number => Math.max(1, Math.round(60 / Math.max(1, fps)));

function toViewerInfo(opts: ViewerOptions): ViewerInfo {
  return {
    fps: opts.fps ?? 24,
    quality: clampQuality(opts.quality ?? DEFAULT_VIEWER.quality),
    maxWidth: clampWidth(opts.maxWidth ?? DEFAULT_VIEWER.maxWidth),
    maxHeight: clampHeight(opts.maxHeight ?? DEFAULT_VIEWER.maxHeight),
  };
}

export class ScreenStreamHub {
  private casters = new Map<string, CasterEntry>();

  /**
   * 加入 viewer;该 browserId 首个 viewer 会创建并启动 ScreenCaster。
   * 失败时向 sink 发 error 消息(语义同旧 addViewer)。
   */
  async addViewer(browserId: string, sink: ViewerSink, opts: ViewerOptions = {}): Promise<void> {
    let entry = this.casters.get(browserId);
    const info = toViewerInfo(opts);

    if (!entry) {
      try {
        const page = await BrowserManager.getSelectedPage(browserId);
        const caster = new ScreenCaster(page, {
          quality: info.quality,
          maxWidth: info.maxWidth,
          maxHeight: info.maxHeight,
          everyNthFrame: everyNthFrameOf(info.fps),
        });

        entry = { caster, viewers: new Map(), seq: 0, lastFrame: null, follow: null };
        this.casters.set(browserId, entry);

        caster.on('frame', (frame: ScreencastFrame) => this.broadcastFrame(browserId, frame));
        caster.on('error', (error: Error) => {
          const e = this.casters.get(browserId);
          if (e) {
            for (const viewer of e.viewers.keys()) {
              if (viewer.isOpen()) {
                viewer.send({
                  type: 'error',
                  failure: { code: 'caster-failed', retryable: true, message: error.message },
                });
              }
            }
          }
        });

        entry.viewers.set(sink, info);
        sink.send({ type: 'started', browserId });

        await caster.start();
        if (this.casters.get(browserId) !== entry || entry.viewers.size === 0) {
          await caster.stop().catch(() => undefined);
          return;
        }
        entry.follow = setInterval(() => {
          void BrowserManager.getSelectedPage(browserId)
            .then((selectedPage) => caster.rebind(selectedPage))
            .catch(() => undefined);
        }, FOLLOW_SELECTED_PAGE_MS);
        await this.reconcile(browserId);
        return;
      } catch (error) {
        if (entry?.follow) clearInterval(entry.follow);
        await entry?.caster.stop().catch(() => undefined);
        this.casters.delete(browserId);
        sink.send({
          type: 'error',
          failure: {
            code: entry ? 'caster-failed' : 'target-not-ready',
            retryable: true,
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
    }

    entry.viewers.set(sink, info);
    sink.send({ type: 'started', browserId });

    if (entry.lastFrame) {
      this.sendFrameToViewer(sink, browserId, entry, entry.lastFrame);
    }

    await this.reconcile(browserId);
  }

  /** 移除 viewer;清零时停 caster */
  removeViewer(browserId: string, sink: ViewerSink): void {
    const entry = this.casters.get(browserId);
    if (!entry) return;
    entry.viewers.delete(sink);
    if (entry.viewers.size === 0) {
      if (entry.follow) clearInterval(entry.follow);
      entry.caster.stop().catch(() => undefined);
      this.casters.delete(browserId);
    } else {
      this.reconcile(browserId).catch(() => undefined);
    }
  }

  async updateViewerFps(browserId: string, sink: ViewerSink, fps: number): Promise<void> {
    const entry = this.casters.get(browserId);
    if (!entry) return;
    const viewerInfo = entry.viewers.get(sink);
    if (viewerInfo) {
      viewerInfo.fps = fps;
      await this.reconcile(browserId);
    }
  }

  /** 面板尺寸变化或进出全屏时，在运行期更新画质和分辨率。 */
  async updateViewerQuality(
    browserId: string,
    sink: ViewerSink,
    opts: { quality?: number; maxWidth?: number; maxHeight?: number }
  ): Promise<void> {
    const entry = this.casters.get(browserId);
    if (!entry) return;
    const viewerInfo = entry.viewers.get(sink);
    if (!viewerInfo) return;
    if (opts.quality !== undefined) viewerInfo.quality = clampQuality(opts.quality);
    if (opts.maxWidth !== undefined) viewerInfo.maxWidth = clampWidth(opts.maxWidth);
    if (opts.maxHeight !== undefined) viewerInfo.maxHeight = clampHeight(opts.maxHeight);
    await this.reconcile(browserId);
  }

  /**
   * 采集参数 = 所有 viewer 的逐项最大值。
   * 取最大而非取最后一个：内联小面板与全屏大窗可能同时在看，按最大者采集，
   * 小面板自己缩小显示即可；反过来大窗就只能拿到糊图。
   */
  private async reconcile(browserId: string): Promise<void> {
    const entry = this.casters.get(browserId);
    if (!entry || entry.viewers.size === 0) return;
    let fps = 0;
    let quality = 0;
    let maxWidth = 0;
    let maxHeight = 0;
    for (const viewer of entry.viewers.values()) {
      if (viewer.fps > fps) fps = viewer.fps;
      if (viewer.quality > quality) quality = viewer.quality;
      if (viewer.maxWidth > maxWidth) maxWidth = viewer.maxWidth;
      if (viewer.maxHeight > maxHeight) maxHeight = viewer.maxHeight;
    }
    await entry.caster.setOptions({
      everyNthFrame: everyNthFrameOf(fps),
      quality,
      maxWidth,
      maxHeight,
    });
  }

  private broadcastFrame(browserId: string, frame: ScreencastFrame): void {
    const entry = this.casters.get(browserId);
    if (!entry) return;

    entry.lastFrame = frame;
    entry.seq++;

    for (const sink of entry.viewers.keys()) {
      this.sendFrameToViewer(sink, browserId, entry, frame);
    }
  }

  private sendFrameToViewer(
    sink: ViewerSink,
    browserId: string,
    entry: CasterEntry,
    frame: ScreencastFrame
  ): void {
    if (!sink.isOpen()) return;

    sink.send({
      type: 'frame',
      meta: {
        seq: entry.seq,
        browserId,
        width: frame.deviceWidth,
        height: frame.deviceHeight,
        scrollX: frame.scrollOffsetX,
        scrollY: frame.scrollOffsetY,
        timestamp: frame.timestamp,
      },
      data: Buffer.from(frame.data, 'base64'),
    });
  }

  /**
   * 转发一次远程输入到被控页面。
   * 未在采集(无 caster)时静默丢弃 —— 用户看不到画面时的输入没有意义。
   */
  async dispatchInput(browserId: string, event: RemoteInputEvent): Promise<void> {
    const entry = this.casters.get(browserId);
    if (!entry) return;
    await entry.caster.dispatchInput(event);
  }

  /** 停全部 caster(应用退出) */
  close(): void {
    for (const [, entry] of this.casters) {
      if (entry.follow) clearInterval(entry.follow);
      entry.caster.stop().catch(() => undefined);
    }
    this.casters.clear();
  }
}

/** 模块级单例(与 BrowserManager 同模块图) */
export const screenStreamHub = new ScreenStreamHub();
