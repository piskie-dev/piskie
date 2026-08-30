/**
 * 浏览器屏幕流 MessagePort IPC 协议
 *
 * 传输层:主进程 ScreenStreamHub/CDP
 * → MessageChannelMain → 渲染进程 → Web Worker 解码绘制。
 *
 * 协议要点:
 * - frame_meta + binary 合并为单条 { type:'frame', ... } 消息(原子,无乱序)
 * - 无端口级重连:renderer reload = 端口 close + 重新 request(主进程按 close 摘除 viewer)
 * - 背压:JPEG 流按 sink "最多 1 帧在途 + latest-wins",Worker 每绘制一帧回 ack
 */

/** Renderer 通过 desktop capability 协商浏览器流的 child MessagePort。 */
export interface BrowserStreamRequest {
  /** 渲染端生成的请求 ID,用于匹配随后到达的 MessagePort */
  requestId: string;
  kind?: 'browser';
  browserId: string;
  fps?: number;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export type ScreenStreamRequest = BrowserStreamRequest;

/** 帧元数据(语义同旧 WS frame_meta) */
export interface StreamFrameMeta {
  seq: number;
  browserId: string;
  width?: number;
  height?: number;
  scrollX?: number;
  scrollY?: number;
  timestamp: number;
}

export interface ScreenStreamFailure {
  readonly code: 'target-not-ready' | 'caster-failed' | 'stream-closed';
  readonly retryable: boolean;
  readonly message: string;
}

/** 主进程 → Worker(经 MessagePort) */
export type StreamServerMessage =
  | { type: 'started'; browserId: string }
  | { type: 'frame'; meta: StreamFrameMeta; data: Uint8Array }
  | { type: 'error'; failure: ScreenStreamFailure };

/**
 * 可交互投屏使用的远程输入事件。
 *
 * 坐标由**渲染端**换算成被控页面的视口 CSS 像素后再上行 —— 只有渲染端同时知道
 * canvas 的显示矩形与 object-fit 的letterbox偏移,主进程不重复推导。
 * 主进程只做一次 CDP `Input.dispatch*` 转发,不加工。
 *
 * 注意:CDP 注入的事件在页面里 `isTrusted === true`,与真实硬件输入不可区分,
 * 因此不会给被控浏览器引入新的自动化特征。
 */
export type RemoteInputEvent =
  | {
      kind: 'mouse';
      type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
      /** 被控页面视口 CSS 像素 */
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle' | 'back' | 'forward' | 'none';
      /** CDP buttons 位掩码(左1/右2/中4) */
      buttons?: number;
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      /** CDP modifiers 位掩码(Alt1/Ctrl2/Meta4/Shift8) */
      modifiers?: number;
    }
  | {
      kind: 'key';
      type: 'keyDown' | 'keyUp' | 'char';
      key?: string;
      code?: string;
      text?: string;
      windowsVirtualKeyCode?: number;
      modifiers?: number;
    }
  /** 输入法/粘贴等成段文本:走 Input.insertText,不拆成按键序列 */
  | { kind: 'text'; text: string };

/** Worker → 主进程(经 MessagePort) */
export type StreamControlMessage =
  | { type: 'set-fps'; fps: number }
  /** 用户在面板内的鼠标/键盘操作会转发进被控浏览器。 */
  | { type: 'input'; event: RemoteInputEvent }
  /**
   * 运行期修改画质或分辨率：面板尺寸变化、进出全屏时重设，
   * 让采集分辨率贴合显示区域的设备像素——避免"采低了再放大"的糊。
   * 生效方式同 set-fps(hub 取所有 viewer 的最大值后重启 screencast)。
   */
  | { type: 'set-quality'; quality?: number; maxWidth?: number; maxHeight?: number }
  /** 每绘制完一帧回执一次,驱动 1-in-flight 背压 */
  | { type: 'ack' }
  | { type: 'stop' };
