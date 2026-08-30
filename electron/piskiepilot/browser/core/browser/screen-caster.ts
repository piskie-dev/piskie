/**
 * Screen Caster
 * 职责:
 * - 使用 CDP Page.startScreencast 实现页面录制
 * - 通过 EventEmitter 推送视频帧
 * - 管理 CDP Session 生命周期
 */

import { Page, CDPSession } from 'puppeteer-core';
import { EventEmitter } from 'events';
import debug from 'debug';

import type { RemoteInputEvent } from '@shared/types/stream.js';

const logger = debug('piskiepilot:screen-caster');

/**
 * Screencast 配置选项
 */
export interface ScreencastOptions {
  /** 图像格式 */
  format?: 'jpeg' | 'png';
  /** 图像质量 (0-100)，仅 JPEG 有效 */
  quality?: number;
  /** 传输图像最大宽度 (px) */
  maxWidth?: number;
  /** 传输图像最大高度 (px) */
  maxHeight?: number;
  /** 每 N 帧发送一帧 (用于控制帧率) */
  everyNthFrame?: number;
}

/**
 * Screencast 帧数据
 */
export interface ScreencastFrame {
  /** base64 编码的图像数据 */
  data: string;
  /** 时间戳 (ms) */
  timestamp: number;
  /** 设备宽度 (px) */
  deviceWidth?: number;
  /** 设备高度 (px) */
  deviceHeight?: number;
  /** 水平滚动偏移 */
  scrollOffsetX?: number;
  /** 垂直滚动偏移 */
  scrollOffsetY?: number;
}

/**
 * Screen Caster
 *
 * 使用 CDP Page.startScreencast 实现页面实时录制
 *
 * @example
 * ```typescript
 * const caster = new ScreenCaster(page, { quality: 80, maxWidth: 1280 });
 *
 * caster.on('frame', (frame) => {
 *   console.log('Received frame:', frame.timestamp);
 * });
 *
 * await caster.start();
 * // ... 一段时间后
 * await caster.stop();
 * ```
 */
export class ScreenCaster extends EventEmitter {
  private cdpSession: CDPSession | null = null;
  private isRunning = false;
  private page: Page;
  private options: Required<ScreencastOptions>;
  private setFpsTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingOptions: Required<ScreencastOptions> | null = null;
  /** rebind 串行链：连续快速选页时也保证 stop/start 不交叠 */
  private rebindChain: Promise<void> = Promise.resolve();

  constructor(page: Page, options: ScreencastOptions = {}) {
    super();
    this.page = page;
    this.options = {
      format: options.format || 'jpeg',
      quality: options.quality ?? 80,
      maxWidth: options.maxWidth ?? 1280,
      maxHeight: options.maxHeight ?? 720,
      everyNthFrame: options.everyNthFrame ?? 1,
    };
  }

  /**
   * 启动 Screencast
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger('Screencast already running, skipping start');
      return;
    }

    try {
      // 创建 CDP Session
      this.cdpSession = await this.page.createCDPSession();

      // 监听帧事件
      this.cdpSession.on('Page.screencastFrame', async (frame: any) => {
        try {
          // 必须确认收到帧，否则会停止发送
          await this.cdpSession?.send('Page.screencastFrameAck', {
            sessionId: frame.sessionId,
          });

          // 构造帧数据
          const frameData: ScreencastFrame = {
            data: frame.data,
            timestamp: Date.now(),
            deviceWidth: frame.metadata?.deviceWidth,
            deviceHeight: frame.metadata?.deviceHeight,
            scrollOffsetX: frame.metadata?.scrollOffsetX,
            scrollOffsetY: frame.metadata?.scrollOffsetY,
          };

          // 发送帧事件
          this.emit('frame', frameData);
        } catch (error) {
          logger('Error processing frame: %O', error);
          this.emit('error', error as Error);
        }
      });

      // 启动 Screencast
      await this.cdpSession.send('Page.startScreencast', {
        format: this.options.format,
        quality: this.options.quality,
        maxWidth: this.options.maxWidth,
        maxHeight: this.options.maxHeight,
        everyNthFrame: this.options.everyNthFrame,
      });

      this.isRunning = true;
      logger(
        'Screencast started: format=%s, quality=%d, size=%dx%d, everyNthFrame=%d, url=%s',
        this.options.format,
        this.options.quality,
        this.options.maxWidth,
        this.options.maxHeight,
        this.options.everyNthFrame,
        this.page.url()
      );

      this.captureFirstFrame().catch(err => {
        logger('Failed to capture first frame: %O', err);
      });
    } catch (error) {
      logger('Failed to start screencast: %O', error);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * 停止 Screencast
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger('Screencast not running, skipping stop');
      return;
    }

    await this.cleanup();
    this.emit('stop');
    logger('Screencast stopped');
  }

  /**
   * 重挂到新的逻辑选中页：停旧 CDP session，在新页上按当前参数重启。
   * 帧/错误监听都在 caster 自身（EventEmitter），跨重挂保留；输入转发随 session 一起切换。
   * 未在运行时只替换目标页，等下次 start 生效。
   */
  async rebind(page: Page): Promise<void> {
    this.rebindChain = this.rebindChain.then(async () => {
      if (page === this.page || page.isClosed()) return;
      const wasRunning = this.isRunning;
      this.page = page;
      if (!wasRunning) return;
      await this.cleanup();
      await this.start();
      logger('Screencast rebound to selected page: %s', page.url());
    });
    this.rebindChain = this.rebindChain.catch((error) => {
      logger('Failed to rebind screencast: %O', error);
      this.emit('error', error as Error);
    });
    return this.rebindChain;
  }

  /**
   * 运行期改采集参数(帧率/画质/分辨率上限)。
   *
   * CDP 没有"改参数"命令，只能 stop+start，所以合并 200ms 防抖后统一重启一次
   * ——面板拖拽尺寸会连发几十次 set-quality，逐次重启会把流打断成幻灯片。
   */
  async setOptions(next: Partial<Required<ScreencastOptions>>): Promise<void> {
    const merged: Required<ScreencastOptions> = { ...this.options, ...this.pendingOptions };
    for (const [key, value] of Object.entries(next)) {
      if (value !== undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
    if (this.sameAsCurrent(merged)) {
      this.pendingOptions = null;
      return;
    }
    this.pendingOptions = merged;

    if (this.setFpsTimer) {
      clearTimeout(this.setFpsTimer);
    }

    this.setFpsTimer = setTimeout(async () => {
      this.setFpsTimer = null;
      const target = this.pendingOptions;
      this.pendingOptions = null;
      if (!target || this.sameAsCurrent(target)) return;

      this.options = target;
      if (this.isRunning && this.cdpSession) {
        try {
          await this.cdpSession.send('Page.stopScreencast');
          await this.cdpSession.send('Page.startScreencast', {
            format: target.format,
            quality: target.quality,
            maxWidth: target.maxWidth,
            maxHeight: target.maxHeight,
            everyNthFrame: target.everyNthFrame,
          });
          logger(
            'Screencast options changed: quality=%d, size=%dx%d, everyNthFrame=%d',
            target.quality,
            target.maxWidth,
            target.maxHeight,
            target.everyNthFrame
          );
        } catch (error) {
          logger('Failed to change screencast options: %O', error);
          this.emit('error', error as Error);
        }
      }
    }, 200);
  }

  private sameAsCurrent(next: Required<ScreencastOptions>): boolean {
    return (
      next.format === this.options.format &&
      next.quality === this.options.quality &&
      next.maxWidth === this.options.maxWidth &&
      next.maxHeight === this.options.maxHeight &&
      next.everyNthFrame === this.options.everyNthFrame
    );
  }

  /**
   * 把用户在预览面板里的输入转发进被控页面。
   *
   * 复用 screencast 已经建好的那条 CDP session —— 不额外 attach:多开一条
   * session 只会让 target 上的客户端更多,没有任何收益。
   * 坐标已由渲染端换算成视口 CSS 像素,这里不做任何加工。
   */
  async dispatchInput(event: RemoteInputEvent): Promise<void> {
    const session = this.cdpSession;
    if (!session || !this.isRunning) return;

    if (event.kind === 'mouse') {
      await session.send('Input.dispatchMouseEvent', {
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.button ?? 'none',
        buttons: event.buttons ?? 0,
        clickCount: event.clickCount ?? 0,
        modifiers: event.modifiers ?? 0,
        ...(event.type === 'mouseWheel'
          ? { deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0 }
          : {}),
      });
      return;
    }

    if (event.kind === 'key') {
      await session.send('Input.dispatchKeyEvent', {
        type: event.type,
        key: event.key,
        code: event.code,
        text: event.text,
        // char 事件要 unmodifiedText 才能在部分输入框里落字
        unmodifiedText: event.type === 'char' ? event.text : undefined,
        windowsVirtualKeyCode: event.windowsVirtualKeyCode,
        nativeVirtualKeyCode: event.windowsVirtualKeyCode,
        modifiers: event.modifiers ?? 0,
      });
      return;
    }

    await session.send('Input.insertText', { text: event.text });
  }

  private async captureFirstFrame(): Promise<void> {
    if (!this.cdpSession || !this.isRunning) return;

    const result = await this.cdpSession.send('Page.captureScreenshot', {
      format: this.options.format,
      quality: this.options.quality,
    });

    if (!this.isRunning) return;

    const viewport = this.page.viewport();
    this.emit('frame', {
      data: result.data,
      timestamp: Date.now(),
      deviceWidth: viewport?.width,
      deviceHeight: viewport?.height,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    } as ScreencastFrame);
  }

  private async cleanup(): Promise<void> {
    if (this.setFpsTimer) {
      clearTimeout(this.setFpsTimer);
      this.setFpsTimer = null;
      this.pendingOptions = null;
    }
    if (this.cdpSession) {
      try {
        if (this.isRunning) {
          await this.cdpSession.send('Page.stopScreencast');
        }
        await this.cdpSession.detach();
      } catch (error) {
        logger('Error during cleanup: %O', error);
      }
      this.cdpSession = null;
    }
    this.isRunning = false;
  }

}
