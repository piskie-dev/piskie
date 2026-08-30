import { createUuid } from '@shared/utils/identifiers.js';
/**
 * 浏览器屏幕流端口获取
 *
 * 流程:生成 requestId → invoke screen:request-stream → preload 把主进程
 * 投递的 MessagePort 经 window message('piskie-screen-stream-port')转交
 * → 按 requestId 认领端口 → 交给解码 Worker。
 *
 * 无端口级重连:流断开(端口 close)后由组件重新调用本函数恢复。
 */

export interface BrowserStreamOptions {
  browserId: string;
  fps?: number;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
}

interface StreamPortEventData {
  type: 'piskie-screen-stream-port';
  requestId: string;
}

const PORT_WAIT_TIMEOUT_MS = 10000;

type StreamRequestParams = { kind?: 'browser' } & BrowserStreamOptions;

export type ScreenStreamPortErrorCode = 'timeout' | 'missing';

export class ScreenStreamPortError extends Error {
  constructor(readonly code: ScreenStreamPortErrorCode) {
    super(code === 'timeout' ? 'Screen stream port timed out' : 'Screen stream port is missing');
    this.name = 'ScreenStreamPortError';
  }
}

async function requestStreamPort(params: StreamRequestParams): Promise<MessagePort> {
  const requestId = createUuid();

  let cleanup = () => {};
  const portPromise = new Promise<MessagePort>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new ScreenStreamPortError('timeout'));
    }, PORT_WAIT_TIMEOUT_MS);
    cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };

    function onMessage(event: MessageEvent) {
      const data = event.data as StreamPortEventData | undefined;
      if (data?.type !== 'piskie-screen-stream-port' || data.requestId !== requestId) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      const port = event.ports[0];
      if (!port) {
        reject(new ScreenStreamPortError('missing'));
        return;
      }
      resolve(port);
    }

    window.addEventListener('message', onMessage);
  });

  // invoke 失败时必须撤掉 timer 与 listener,否则 portPromise 10s 后
  // 变成 unhandled rejection(cleanup 后 promise 永不 settle,交给 GC)
  try {
    await window.piskie.pilot.screen.requestStream({ requestId, ...params });
  } catch (err) {
    cleanup();
    throw err;
  }

  return portPromise;
}

export function requestBrowserStreamPort(options: BrowserStreamOptions): Promise<MessagePort> {
  return requestStreamPort({ ...options });
}
