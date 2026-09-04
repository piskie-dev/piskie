import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const CALLBACK_PATH = '/oauth/callback';
const MAX_CALLBACK_URL_BYTES = 24 * 1024;

const CALLBACK_COPY = {
  'en-US': {
    brand: 'PISKIE / DESKTOP AUTH',
    deniedMessage: 'This request was cancelled. You can close this page.',
    deniedTitle: 'Sign-in not authorized',
    invalidMessage: 'This callback does not match the current Piskie sign-in request.',
    invalidTitle: 'Sign-in verification failed',
    notFoundMessage: 'Return to Piskie and start sign-in again.',
    notFoundTitle: 'Sign-in request not found',
    processedMessage: 'Return to Piskie to check the sign-in status.',
    processedTitle: 'Sign-in request already handled',
    successMessage: 'You can close this page and return to Piskie.',
    successTitle: 'Sign-in complete',
  },
  'zh-CN': {
    brand: 'PISKIE / 桌面登录',
    deniedMessage: '此次请求已取消，可以关闭此页面。',
    deniedTitle: '登录未授权',
    invalidMessage: '此回调与当前 Piskie 登录请求不匹配。',
    invalidTitle: '登录验证失败',
    notFoundMessage: '请返回 Piskie 重新发起登录。',
    notFoundTitle: '找不到登录请求',
    processedMessage: '请返回 Piskie 查看登录状态。',
    processedTitle: '登录请求已处理',
    successMessage: '现在可以关闭此页面并返回 Piskie。',
    successTitle: '登录已完成',
  },
} as const;

type CallbackLocale = keyof typeof CALLBACK_COPY;

export type OAuthCallbackResult =
  | { readonly code: string }
  | { readonly error: string; readonly errorDescription?: string };

export interface OAuthLoopbackListener {
  readonly redirectUri: string;
  wait(signal: AbortSignal): Promise<OAuthCallbackResult>;
  close(): void;
}

export type OAuthLoopbackListenerFactory = (options: {
  expectedIssuer: string;
  expectedState: string;
  timeoutMs: number;
}) => Promise<OAuthLoopbackListener>;

export async function startOAuthLoopbackListener(options: {
  expectedIssuer: string;
  expectedState: string;
  timeoutMs: number;
}): Promise<OAuthLoopbackListener> {
  let resolveResult: ((result: OAuthCallbackResult) => void) | undefined;
  const result = new Promise<OAuthCallbackResult>((resolve) => {
    resolveResult = resolve;
  });
  let settled = false;
  let closed = false;

  const server: Server = createServer((request, response) => {
    const locale = resolveCallbackLocale(request.headers['accept-language']);
    const copy = CALLBACK_COPY[locale];
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (
      request.method !== 'GET'
      || !request.url
      || Buffer.byteLength(request.url, 'utf8') > MAX_CALLBACK_URL_BYTES
    ) {
      respond(response, 404, callbackPage(locale, copy.notFoundTitle, copy.notFoundMessage));
      return;
    }

    const target = new URL(request.url, 'http://127.0.0.1');
    if (target.pathname !== CALLBACK_PATH) {
      respond(response, 404, callbackPage(locale, copy.notFoundTitle, copy.notFoundMessage));
      return;
    }

    const state = singleValue(target.searchParams, 'state');
    const issuer = singleValue(target.searchParams, 'iss');
    const code = singleValue(target.searchParams, 'code');
    const error = singleValue(target.searchParams, 'error');
    const errorDescription = singleValue(target.searchParams, 'error_description');

    if (
      !state
      || state !== options.expectedState
      || !issuer
      || issuer !== options.expectedIssuer
      || (code === null) === (error === null)
      || (code !== null && (code.length === 0 || code.length > 16_384))
      || (error !== null && (error.length === 0 || error.length > 128))
      || (errorDescription !== null && errorDescription.length > 1_024)
    ) {
      respond(response, 400, callbackPage(locale, copy.invalidTitle, copy.invalidMessage));
      return;
    }

    if (settled) {
      respond(response, 409, callbackPage(locale, copy.processedTitle, copy.processedMessage));
      return;
    }

    settled = true;
    clearTimeout(timeout);
    const callbackResult: OAuthCallbackResult = code !== null
      ? { code }
      : {
          error: error as string,
          ...(errorDescription && { errorDescription }),
        };
    response.once('finish', () => close());
    respond(
      response,
      200,
      code !== null
        ? callbackPage(locale, copy.successTitle, copy.successMessage)
        : callbackPage(locale, copy.deniedTitle, copy.deniedMessage),
    );
    resolveResult?.(callbackResult);
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => reject(error);
    server.once('error', handleError);
    server.listen({ exclusive: true, host: '127.0.0.1', port: 0 }, () => {
      server.removeListener('error', handleError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to allocate the OAuth callback port');
  }

  server.unref();
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolveResult?.({ error: 'expired' });
    close();
  }, options.timeoutMs);
  timeout.unref?.();
  server.on('error', () => {
    if (settled) return;
    settled = true;
    resolveResult?.({ error: 'callback_failed' });
    close();
  });

  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    server.close();
  }

  return Object.freeze({
    redirectUri: callbackUrl(address),
    wait: (signal: AbortSignal) => waitWithAbort(result, signal),
    close,
  });
}

function callbackUrl(address: AddressInfo): string {
  return `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
}

function singleValue(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] ?? null : null;
}

function respond(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
}

function callbackPage(locale: CallbackLocale, title: string, message: string): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} | Piskie</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#080808;color:#0a0a0a;font-family:"Avenir Next","PingFang SC","Microsoft YaHei",sans-serif}.panel{width:min(100%,430px);border:1px solid #000;border-radius:6px;background:#fafafa;box-shadow:10px 10px 0 rgba(255,255,255,.06)}.bar{height:4px;background:#0a0a0a}.head{padding:28px 30px 21px;border-bottom:1px solid #d7d7d7}.brand{margin:0 0 9px;color:#555;font:700 10px ui-monospace,SFMono-Regular,Consolas,monospace}.head h1{margin:0;font-size:25px;line-height:1.25}.body{padding:28px 30px 32px}.body p{margin:0;color:#666;font-size:14px;line-height:1.7}@media(max-width:520px){.head,.body{padding-left:22px;padding-right:22px}}
  </style>
</head>
<body>
  <main class="panel"><div class="bar"></div><header class="head"><p class="brand">${CALLBACK_COPY[locale].brand}</p><h1>${title}</h1></header><section class="body"><p>${message}</p></section></main>
</body>
</html>`;
}

function resolveCallbackLocale(value: string | string[] | undefined): CallbackLocale {
  const header = Array.isArray(value) ? value.join(',') : value;
  if (!header) return 'en-US';

  const preferences = header
    .slice(0, 4_096)
    .split(',', 32)
    .map((entry, order) => {
      const [rawTag, ...parameters] = entry.trim().split(';');
      let quality = 1;
      for (const parameter of parameters) {
        const match = /^\s*q\s*=\s*(\d(?:\.\d+)?)\s*$/i.exec(parameter);
        if (!match) continue;
        const parsed = Number(match[1]);
        quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
      }
      return { order, quality, tag: rawTag?.trim().toLowerCase() ?? '' };
    })
    .sort((left, right) => right.quality - left.quality || left.order - right.order);

  for (const preference of preferences) {
    if (preference.quality <= 0) continue;
    if (preference.tag === 'zh' || preference.tag.startsWith('zh-')) return 'zh-CN';
    if (preference.tag === 'en' || preference.tag.startsWith('en-')) return 'en-US';
    if (preference.tag === '*') return 'en-US';
  }
  return 'en-US';
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('The operation was cancelled');
  error.name = 'AbortError';
  return error;
}
