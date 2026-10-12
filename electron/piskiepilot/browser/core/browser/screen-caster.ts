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

import { sameScreenPage, type RemoteInputEvent, type ScreenPageIdentity, type ScreenFrameMapping } from '@shared/types/stream.js';

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
  page?: ScreenPageIdentity;
  mapping?: ScreenFrameMapping;
}

export interface SuccessfulScreenInput {
  readonly event: RemoteInputEvent;
  readonly page: Page;
  readonly identity: ScreenPageIdentity | undefined;
  readonly seq: number;
  readonly timestamp: number;
  readonly sourceOrder?: number;
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
  private runningGeneration = 0;
  private page: Page;
  private options: Required<ScreencastOptions>;
  private setFpsTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingOptions: Required<ScreencastOptions> | null = null;
  private optionsRestartGeneration = 0;
  /** rebind 串行链：连续快速选页时也保证 stop/start 不交叠 */
  private rebindChain: Promise<void> = Promise.resolve();
  private captureGeneration = 0;
  private targetGeneration = 0;
  private startRequested = false;
  private identity: ScreenPageIdentity | undefined;
  private inputSequence = 0;
  private frameCapture: { session: CDPSession; generation: number; promise: Promise<void> } | null = null;

  constructor(page: Page, options: ScreencastOptions = {}, identity?: ScreenPageIdentity,
    private readonly reserveInputOrder?: () => number) {
    super();
    this.page = page;
    this.identity = identity;
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
    this.startRequested = true;
    if (this.isRunning) {
      logger('Screencast already running, skipping start');
      return;
    }

    const generation = ++this.captureGeneration;
    try {
      const page = this.page;
      const identity = this.identity;
      const session = await page.createCDPSession();
      if (generation !== this.captureGeneration) {
        await session.detach();
        return;
      }
      this.cdpSession = session;

      // Each callback retains its capture owner across asynchronous ACKs.
      session.on('Page.screencastFrame', async (frame) => {
        const timestamp = Date.now();
        const current = () => generation === this.captureGeneration && this.cdpSession === session;
        try {
          // 必须确认收到帧，否则会停止发送
          await session.send('Page.screencastFrameAck', {
            sessionId: frame.sessionId,
          });

          if (!current()) return;
          // 构造帧数据
          const frameData: ScreencastFrame = {
            data: frame.data,
            timestamp,
            deviceWidth: frame.metadata?.deviceWidth,
            deviceHeight: frame.metadata?.deviceHeight,
            scrollOffsetX: frame.metadata?.scrollOffsetX,
            scrollOffsetY: frame.metadata?.scrollOffsetY,
            page: identity,
            mapping: { scale: frame.metadata?.pageScaleFactor ?? 1, offsetX: 0, offsetY: frame.metadata?.offsetTop ?? 0 },
          };

          // 发送帧事件
          this.emit('frame', frameData);
        } catch (error) {
          logger('Error processing frame: %O', error);
          if (current()) this.emit('error', error as Error);
        }
      });

      // 启动 Screencast
      await session.send('Page.startScreencast', {
        format: this.options.format,
        quality: this.options.quality,
        maxWidth: this.options.maxWidth,
        maxHeight: this.options.maxHeight,
        everyNthFrame: this.options.everyNthFrame,
      });

      if (generation !== this.captureGeneration) return;
      this.isRunning = true;
      this.runningGeneration = generation;
      logger(
        'Screencast started: format=%s, quality=%d, size=%dx%d, everyNthFrame=%d, url=%s',
        this.options.format,
        this.options.quality,
        this.options.maxWidth,
        this.options.maxHeight,
        this.options.everyNthFrame,
        this.page.url()
      );

      this.captureFirstFrame(session, page, identity, generation).catch(err => {
        logger('Failed to capture first frame: %O', err);
      });
    } catch (error) {
      if (generation !== this.captureGeneration) return;
      logger('Failed to start screencast: %O', error);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * 停止 Screencast
   */
  async stop(): Promise<void> {
    this.startRequested = false;
    this.targetGeneration += 1;
    await this.cleanup();
    this.emit('stop');
    logger('Screencast stopped');
  }

  /**
   * 重挂到新的逻辑选中页：停旧 CDP session，在新页上按当前参数重启。
   * 帧/错误监听都在 caster 自身（EventEmitter），跨重挂保留；输入转发随 session 一起切换。
   * 未在运行时只替换目标页，等下次 start 生效。
   */
  async rebind(page: Page, identity?: ScreenPageIdentity): Promise<void> {
    if (page === this.page && (identity === this.identity || sameScreenPage(identity, this.identity))) return this.rebindChain;
    if (page.isClosed()) return;
    // The requested target is authoritative, even while an older stop/start is awaiting CDP.
    this.page = page;
    this.identity = identity;
    const targetGeneration = ++this.targetGeneration;
    this.captureGeneration += 1;
    this.rebindChain = this.rebindChain.then(async () => {
      if (targetGeneration !== this.targetGeneration) return;
      await this.cleanup();
      if (targetGeneration !== this.targetGeneration || !this.startRequested) return;
      await this.start();
      logger('Screencast rebound to selected page: %s', page.url());
    });
    this.rebindChain = this.rebindChain.catch((error) => {
      logger('Failed to rebind screencast: %O', error);
      if (targetGeneration === this.targetGeneration) this.emit('error', error as Error);
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
      const session = this.cdpSession;
      const captureGeneration = this.captureGeneration;
      const targetGeneration = this.targetGeneration;
      const optionsRestartGeneration = ++this.optionsRestartGeneration;
      const current = () => this.isRunning && this.cdpSession === session
        && this.captureGeneration === captureGeneration && this.targetGeneration === targetGeneration
        && this.optionsRestartGeneration === optionsRestartGeneration;
      if (session && current()) {
        try {
          await session.send('Page.stopScreencast');
          if (!current()) return;
          await session.send('Page.startScreencast', {
            format: target.format,
            quality: target.quality,
            maxWidth: target.maxWidth,
            maxHeight: target.maxHeight,
            everyNthFrame: target.everyNthFrame,
          });
          if (!current()) return;
          logger(
            'Screencast options changed: quality=%d, size=%dx%d, everyNthFrame=%d',
            target.quality,
            target.maxWidth,
            target.maxHeight,
            target.everyNthFrame
          );
        } catch (error) {
          logger('Failed to change screencast options: %O', error);
          if (current()) this.emit('error', error as Error);
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
    const input: SuccessfulScreenInput = { event, page: this.page, identity: this.identity,
      seq: ++this.inputSequence, timestamp: Date.now(), sourceOrder: this.reserveInputOrder?.() };

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
      this.publishInput(input);
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
      this.publishInput(input);
      return;
    }

    await session.send('Input.insertText', { text: event.text });
    this.publishInput(input);
  }

  private publishInput(input: SuccessfulScreenInput): void {
    try { this.emit('input', input); }
    catch (error) { logger('Input feedback observer failed: %O', error); }
  }

  /** Request real current pixels when a finite layout change was skipped by screencast sampling. */
  refreshFrame(): Promise<void> {
    const session = this.cdpSession, generation = this.captureGeneration;
    if (!session || !this.isRunning || this.runningGeneration !== generation) return Promise.resolve();
    if (this.frameCapture?.session === session && this.frameCapture.generation === generation) return this.frameCapture.promise;
    const capture = { session, generation, promise: this.captureFirstFrame(session, this.page, this.identity, generation) };
    this.frameCapture = capture;
    void capture.promise.finally(() => { if (this.frameCapture === capture) this.frameCapture = null; }).catch(() => undefined);
    return capture.promise;
  }

  private async captureFirstFrame(
    session: CDPSession, page: Page, identity: ScreenPageIdentity | undefined, generation: number,
  ): Promise<void> {
    const timestamp = Date.now();
    const [result, metrics] = await Promise.all([
      session.send('Page.captureScreenshot', { format: this.options.format, quality: this.options.quality }),
      session.send('Page.getLayoutMetrics'),
    ]);
    if (!this.isRunning || generation !== this.captureGeneration || session !== this.cdpSession || page !== this.page) return;
    const viewport = metrics.visualViewport;
    this.emit('frame', {
      data: result.data, timestamp, page: identity,
      deviceWidth: viewport.clientWidth * viewport.scale,
      deviceHeight: viewport.clientHeight * viewport.scale,
      scrollOffsetX: metrics.cssVisualViewport.pageX,
      scrollOffsetY: metrics.cssVisualViewport.pageY,
      mapping: { scale: viewport.scale, offsetX: 0, offsetY: 0 },
    } satisfies ScreencastFrame);
  }

  private async cleanup(): Promise<void> {
    this.captureGeneration += 1;
    const session = this.cdpSession;
    this.cdpSession = null;
    this.frameCapture = null;
    const wasRunning = this.isRunning;
    this.isRunning = false;
    this.runningGeneration = 0;
    if (this.setFpsTimer) {
      clearTimeout(this.setFpsTimer);
      this.setFpsTimer = null;
      this.pendingOptions = null;
    }
    if (session) {
      try {
        if (wasRunning) {
          await session.send('Page.stopScreencast');
        }
        await session.detach();
      } catch (error) {
        logger('Error during cleanup: %O', error);
      }
      this.cdpSession = null;
    }
    this.isRunning = false;
  }

}
