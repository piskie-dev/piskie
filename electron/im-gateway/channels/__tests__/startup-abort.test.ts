/**
 * 四渠道启动中止（pre-aborted signal）的 abort 契约。
 *
 * 断言：ctx.signal 已 abort 时，connector.start() 必须尽快 settle，
 * 不发起任何网络请求（token/probe/getUpdates/WebSocket）。
 * 真实走通各渠道 vendor 入口（startGateway/monitorFeishuProvider/
 * monitorWeComProvider/startAccount）的 pre-abort 短路路径。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// state dir 重定向必须先于任何 vendor 模块导入（vi.hoisted 在 import 之前执行）。
// Feishu CJS 源码解析由全局 Vitest setup 统一提供。
const hoistedState = await vi.hoisted(async () => {
  const nodeOs = await import('node:os');
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  const stateDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'im-startup-abort-'));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return { stateDir };
});



vi.mock('../../../core/storage/index.js', () => {
  class TaskDefinitionNotFoundError extends Error {
    constructor(definitionId: string) {
      super(`Task Definition not found: ${definitionId}`);
      this.name = 'TaskDefinitionNotFoundError';
    }
  }
  return {
    TaskDefinitionNotFoundError,
    taskDefinitionStore: { get: () => null },
  };
});

import { createFeishuConnector } from '../feishu/index.js';
import { createQQBotConnector } from '../qqbot/index.js';
import { createWeComConnector } from '../wecom/index.js';
import { createWeixinConnector } from '../weixin/index.js';
import type { ConnectorContext } from '../../core/channel-connector.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

function makeBot(overrides: Partial<MessagingConnectionConfig> = {}): MessagingConnectionConfig {
  return {
    id: 'bot-abort-test',
    name: 'AbortTest',
    channelType: 'feishu',
    definitionId: 'td-a',
    appId: 'fake-app-id',
    appSecret: 'fake-app-secret',
    ...overrides,
  } as MessagingConnectionConfig;
}

function makeCtx(bot: MessagingConnectionConfig): ConnectorContext {
  return {
    bot,
    signal: AbortSignal.abort(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pairing: {
      getAllowedSenders: () => [],
      request: () => ({ code: '000000', created: true }),
      buildReply: () => 'pair',
    },
    media: {
      saveBuffer: vi.fn(async () => ({ path: '/dev/null', size: 0 })),
    },
    dispatch: vi.fn(),
    dispatchWithQueue: vi.fn(),
    setLateSink: vi.fn(),
    setStatus: vi.fn(),
  } as unknown as ConnectorContext;
}

/**
 * settle 看门狗：start() 必须在 deadline 内 resolve（pre-abort = 手动停止语义，
 * 见 ChannelConnector 契约「resolve 视为手动停止」）；reject 或超时都算违约。
 */
async function expectSettles(p: Promise<unknown>, deadlineMs = 8000): Promise<void> {
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`start() 未在 ${deadlineMs}ms 内 settle（违反 abort 契约）`)), deadlineMs);
  });
  try {
    await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error('network disabled in startup-abort test');
  });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('四渠道启动中止：pre-aborted signal 下 start() 立即 settle 且零网络请求', () => {
  it('feishu：startWS pre-abort 短路（不 probe、不建 WSClient）', { timeout: 15000 }, async () => {
    const connector = createFeishuConnector(makeBot({ channelType: 'feishu' }));
    await expectSettles(connector.start(makeCtx(makeBot({ channelType: 'feishu' }))));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('qqbot：startGateway 入口 pre-abort 短路（不跑诊断、不取 token）', { timeout: 15000 }, async () => {
    const connector = createQQBotConnector(makeBot({ channelType: 'qqbot' }));
    await expectSettles(connector.start(makeCtx(makeBot({ channelType: 'qqbot' }))));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('wecom：monitor pre-abort 立即 settle（wsClient.disconnect + cleanup）', { timeout: 15000 }, async () => {
    const connector = createWeComConnector(makeBot({ channelType: 'wecom' }));
    await expectSettles(connector.start(makeCtx(makeBot({ channelType: 'wecom' }))));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('weixin：monitor 主循环 pre-abort 不进入（不发 getUpdates）', { timeout: 15000 }, async () => {
    // 伪造已登录态：legacy 凭证 fallback 对任意 accountId 生效（configured=true 才到达主循环）
    const credDir = path.join(hoistedState.stateDir, 'credentials', 'openclaw-weixin');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(path.join(credDir, 'credentials.json'), JSON.stringify({ token: 'fake-token' }), 'utf-8');

    const connector = createWeixinConnector(makeBot({ channelType: 'openclaw-weixin' }));
    await expectSettles(connector.start(makeCtx(makeBot({ channelType: 'openclaw-weixin' }))));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('运行期 abort：在途请求真取消', () => {
  it('feishu probe：startWS 期间 abort → signal 穿透到 SDK request 取消在途 HTTP，缓存不写、WSClient 不创建', { timeout: 15000 }, async () => {
    const { createRequire } = await import('node:module');
    const req = createRequire(__filename);
    // 直接 require CJS vendor（compat 解析钩子已就位）；fromCredentials 为一次性实例，不进全局缓存
    const { LarkClient } = req('../feishu/vendor/src/core/lark-client.js');
    const client = LarkClient.fromCredentials({ accountId: 'probe-abort', appId: 'app', appSecret: 'secret' });

    // 预置 fake SDK（lazy getter 只在 _sdk 为空时构造真实 Client）：
    // request 挂起直到收到的 signal abort 才 reject——模拟在途 HTTP 请求
    let receivedSignal: AbortSignal | undefined;
    const fakeSdk = {
      request: vi.fn((payload: { signal?: AbortSignal }) => new Promise((_, reject) => {
        receivedSignal = payload.signal;
        payload.signal?.addEventListener('abort', () => {
          const err = new Error('canceled');
          err.name = 'CanceledError';
          reject(err);
        }, { once: true });
      })),
    };
    client._sdk = fakeSdk;

    const controller = new AbortController();
    const startP = client.startWS({ handlers: {}, abortSignal: controller.signal, autoProbe: true });

    // probe 已发出且 signal 已穿线进 SDK request（axios 层）
    await vi.waitFor(() => expect(fakeSdk.request).toHaveBeenCalledTimes(1));
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);

    controller.abort(); // 运行期 abort：不是放弃等待，而是取消底层请求
    await expectSettles(startP, 3000);

    expect(receivedSignal?.aborted).toBe(true);
    // 已中止的 probe 绝不写实例缓存（clearCache 后迟到写入会污染已清理实例）
    expect(client._lastProbeResult).toBeNull();
    expect(client.botOpenId).toBeUndefined();
    // abort 复查在创建 EventDispatcher/WSClient 之前
    expect(client._wsClient ?? null).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('weixin getUpdates：外部 signal abort 合入 fetch 取消在途长轮询，AbortError 原样上抛不伪装空响应', { timeout: 15000 }, async () => {
    const api = await import('../weixin/vendor/src/api/api.js');

    let fetchSignal: AbortSignal | undefined;
    fetchSpy.mockImplementation((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        fetchSignal = init.signal;
        init.signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      }));

    const controller = new AbortController();
    const p = api.getUpdates({ baseUrl: 'http://127.0.0.1:1/', token: 't', abortSignal: controller.signal });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSignal?.aborted).toBe(false);

    controller.abort();

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchSignal?.aborted).toBe(true); // AbortSignal.any 合入后底层 fetch 真正收到取消
  });
});

// 复用本文件的 feishu CJS 桥接钩子（media-resolver require 链触及 openclaw-compat）
describe('feishu MediaTypes 与 MediaPaths 下标对位', () => {
  it('缺失 MIME 以 undefined 占位等长配对，不 filter(Boolean) 压缩错位', async () => {
    const { createRequire } = await import('node:module');
    const req = createRequire(__filename);
    const { buildFeishuMediaPayload } = req('../feishu/vendor/src/messaging/inbound/media-resolver.js');

    const payload = buildFeishuMediaPayload([
      { path: '/m/a.png', contentType: 'image/png' },
      { path: '/m/b.bin' }, // 无 contentType：若被 filter 压缩，c.pdf 的 MIME 会错位到 b.bin
      { path: '/m/c.pdf', contentType: 'application/pdf' },
    ]);

    expect(payload.MediaPaths).toEqual(['/m/a.png', '/m/b.bin', '/m/c.pdf']);
    expect(payload.MediaTypes).toEqual(['image/png', undefined, 'application/pdf']);
    expect(payload.MediaTypes).toHaveLength(payload.MediaPaths.length);
  });

  it('空媒体列表：MediaPaths/MediaTypes 均为 undefined', async () => {
    const { createRequire } = await import('node:module');
    const req = createRequire(__filename);
    const { buildFeishuMediaPayload } = req('../feishu/vendor/src/messaging/inbound/media-resolver.js');

    const payload = buildFeishuMediaPayload([]);
    expect(payload.MediaPaths).toBeUndefined();
    expect(payload.MediaTypes).toBeUndefined();
  });
});
