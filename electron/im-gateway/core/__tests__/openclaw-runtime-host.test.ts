/**
 * OpenClawRuntimeHost：
 * - resolveAgentRoute 在 vendor 边界瞬时派生兼容键，
 *   多 Bot 同模板同 peer 不碰撞；无效 peer 返回空路由，不生成含 'unknown' 的 ID；
 * - loadConfig 按账户投影账密与全部准入策略，channel 顶层无 per-bot 策略字段；
 * - dispatchReplyFromConfig 媒体先规整再判空：单数 MediaPath 也形成 InboundMediaFile，
 *   空正文+媒体进入 dispatch，远程 MediaUrl 先下载、失败返回明确回执不降级；
 * - senderName 透传；queuedFinal 只由 counts.final > 0 派生。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
vi.mock('../../../core/storage/index.js', () => ({
  taskDefinitionStore: { get: () => null },
}));

import os from 'os';
import { OpenClawRuntimeHost } from '../openclaw-runtime-host.js';
import { getManagedMediaDir, MEDIA_READ_FAILED_REPLY, MAX_IM_IMAGE_BYTES } from '../inbound-media.js';
import type {
  ConnectorContext,
  DispatchResult,
  InboundMessage,
  ReplyDispatcher,
} from '../channel-connector.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

const VENDOR_AGENT_KEY_PATTERN = /^im-[A-Za-z0-9_-]{43}$/;

function makeBot(overrides: Partial<MessagingConnectionConfig> = {}): MessagingConnectionConfig {
  return {
    id: 'bot-A',
    channelType: 'feishu',
    name: 'Bot A',
    definitionId: 'td-support',
    appId: 'app-a',
    appSecret: 'secret-a',
    ...overrides,
  };
}

interface FakeCtx {
  ctx: ConnectorContext;
  dispatchWithQueue: ReturnType<typeof vi.fn>;
  saveBuffer: ReturnType<typeof vi.fn>;
}

function makeConnectorCtx(bot: MessagingConnectionConfig, dispatchResult?: DispatchResult): FakeCtx {
  const dispatchWithQueue = vi.fn(async () =>
    dispatchResult ?? ({ kind: 'agent', completion: 'yield', counts: { block: 0, tool: 0, final: 1 } } satisfies DispatchResult));
  const saveBuffer = vi.fn(async (buffer: Buffer, contentType?: string) => {
    const dir = getManagedMediaDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `host-test-${Math.random().toString(36).slice(2)}.bin`);
    fs.writeFileSync(p, buffer);
    return { path: p, size: buffer.length, contentType };
  });
  const ctx = {
    bot,
    media: { saveBuffer },
    dispatchWithQueue,
    pairing: { getAllowedSenders: () => [], request: () => ({ code: '000000', created: false }) },
  } as unknown as ConnectorContext;
  return { ctx, dispatchWithQueue, saveBuffer };
}

function makeDispatcher() {
  const calls: string[] = [];
  const finalPayloads: Array<{ text?: string }> = [];
  const counts = { block: 0, tool: 0, final: 0 };
  const dispatcher = {
    sendBlockReply: vi.fn(() => { counts.block += 1; calls.push('block'); return true; }),
    sendToolResult: vi.fn(() => { counts.tool += 1; calls.push('tool'); return true; }),
    sendFinalReply: vi.fn((payload: { text?: string }) => {
      counts.final += 1;
      calls.push('final');
      finalPayloads.push(payload);
      return true;
    }),
    markComplete: vi.fn(() => { calls.push('markComplete'); }),
    waitForIdle: vi.fn(async () => { calls.push('waitForIdle'); }),
    getQueuedCounts: vi.fn(() => ({ ...counts })),
  } as unknown as ReplyDispatcher;
  return { dispatcher, calls, finalPayloads };
}

type RouteFn = (input: {
  channel?: string;
  accountId?: string;
  peer?: { kind?: string; id?: string };
}) => { agentId?: string; sessionKey?: string; mainSessionKey?: string; matchedBy: string };

function routingOf(host: OpenClawRuntimeHost): RouteFn {
  const runtime = host.buildRuntime() as {
    channel: { routing: { resolveAgentRoute: RouteFn } };
  };
  return runtime.channel.routing.resolveAgentRoute;
}

type DispatchFn = (params: {
  ctx?: Record<string, unknown>;
  dispatcher?: unknown;
}) => Promise<{ queuedFinal: boolean; counts: { block: number; tool: number; final: number } }>;

function replyOf(host: OpenClawRuntimeHost): DispatchFn {
  const runtime = host.buildRuntime() as {
    channel: { reply: { dispatchReplyFromConfig: DispatchFn } };
  };
  return runtime.channel.reply.dispatchReplyFromConfig;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveAgentRoute', () => {
  let host: OpenClawRuntimeHost;
  let fake: FakeCtx;

  beforeEach(() => {
    host = new OpenClawRuntimeHost('feishu');
    fake = makeConnectorCtx(makeBot());
    host.register(fake.ctx);
  });

  it('route.agentId 只是在 vendor 边界派生的兼容键', () => {
    const route = routingOf(host)({ accountId: 'bot-A', peer: { kind: 'group', id: 'chat-1' } });
    const expected = route.agentId!;
    expect(expected).toMatch(VENDOR_AGENT_KEY_PATTERN);
    expect(route.agentId).not.toBe('td-support');
    expect(route.sessionKey).toBe(`agent:${expected}:feishu:group:chat-1`);
    expect(route.mainSessionKey).toBe(`agent:${expected}:main`);
    expect(route.matchedBy).toBe('binding.account');
  });

  it('两个 Bot 绑同一模板、面对同一 peer 时 route/sessionKey 不碰撞', () => {
    const fakeB = makeConnectorCtx(makeBot({ id: 'bot-B', appId: 'app-b' }));
    host.register(fakeB.ctx);
    const r1 = routingOf(host)({ accountId: 'bot-A', peer: { kind: 'group', id: 'chat-1' } });
    const r2 = routingOf(host)({ accountId: 'bot-B', peer: { kind: 'group', id: 'chat-1' } });
    expect(r1.agentId).not.toBe(r2.agentId);
    expect(r1.sessionKey).not.toBe(r2.sessionKey);
  });

  it("peer.kind 'dm'归一为 direct，派生与 direct 相同", () => {
    const viaDm = routingOf(host)({ accountId: 'bot-A', peer: { kind: 'dm', id: 'user-1' } });
    const viaDirect = routingOf(host)({ accountId: 'bot-A', peer: { kind: 'direct', id: 'user-1' } });
    expect(viaDm.agentId).toBe(viaDirect.agentId);
    expect(viaDm.sessionKey).toContain(':direct:user-1');
  });

  it("无效 peer（kind 非法/id 空/id='unknown'/无 Bot 上下文）返回空路由，不生成含 unknown 的 ID", () => {
    const route = routingOf(host);
    for (const input of [
      { accountId: 'bot-A', peer: { kind: 'channel', id: 'x' } },
      { accountId: 'bot-A', peer: { kind: 'group', id: '' } },
      { accountId: 'bot-A', peer: { kind: 'group', id: 'unknown' } },
      { accountId: 'bot-A' },
      { accountId: 'no-such-bot', peer: { kind: 'group', id: 'chat-1' } },
    ]) {
      const r = route(input as Parameters<RouteFn>[0]);
      expect(r.agentId).toBeUndefined();
      expect(r.sessionKey).toBeUndefined();
      expect(r.mainSessionKey).toBeUndefined();
      expect(r.matchedBy).toBe('none');
    }
  });
});

describe('loadConfig per-account 投影', () => {
  it('两个 Bot 的准入策略各写入自己的 accounts 条目，channel 顶层无 per-bot 策略', () => {
    const host = new OpenClawRuntimeHost('feishu');
    host.register(makeConnectorCtx(makeBot({
      id: 'bot-A', dmPolicy: 'open', allowFrom: ['u1'], requireMention: false,
    })).ctx);
    host.register(makeConnectorCtx(makeBot({
      id: 'bot-B', appId: 'app-b', appSecret: 'secret-b',
      dmPolicy: 'allowlist', allowFrom: ['u2'], groupPolicy: 'disabled', requireMention: true,
    })).ctx);

    const cfg = host.loadConfig() as {
      channels: Record<string, Record<string, unknown> & { accounts: Record<string, Record<string, unknown>> }>;
    };
    const section = cfg.channels.feishu;
    const a = section.accounts['bot-a'];
    const b = section.accounts['bot-b'];
    expect(a).toMatchObject({ appId: 'app-a', appSecret: 'secret-a', dmPolicy: 'open', allowFrom: ['u1'], requireMention: false });
    expect(b).toMatchObject({ appId: 'app-b', appSecret: 'secret-b', dmPolicy: 'allowlist', allowFrom: ['u2'], groupPolicy: 'disabled', requireMention: true });
    // 顶层不再有会被注册顺序循环覆盖的 per-bot 字段
    for (const key of ['dmPolicy', 'allowFrom', 'groupPolicy', 'groupAllowFrom', 'groupSenderAllowFrom', 'requireMention', 'appId', 'appSecret']) {
      expect(section[key]).toBeUndefined();
    }
  });

  it('qqbot 凭证字段名为 clientSecret，顶层不再冗余账密', () => {
    const host = new OpenClawRuntimeHost('qqbot');
    host.register(makeConnectorCtx(makeBot({ id: 'QQ-Bot-1', channelType: 'qqbot' })).ctx);
    const cfg = host.loadConfig() as {
      channels: Record<string, Record<string, unknown> & { accounts: Record<string, Record<string, unknown>> }>;
    };
    const section = cfg.channels.qqbot;
    // vendorAccountKey 遵循 vendor 小写规整规则（qqbot resolveAccountId lowercases）
    expect(section.accounts['qq-bot-1']).toMatchObject({ appId: 'app-a', clientSecret: 'secret-a' });
    expect(section.appId).toBeUndefined();
    expect(section.clientSecret).toBeUndefined();
  });
});

describe('dispatchReplyFromConfig 媒体规整与空判断', () => {
  let host: OpenClawRuntimeHost;
  let fake: FakeCtx;
  let sessionKey: string;

  beforeEach(() => {
    host = new OpenClawRuntimeHost('feishu');
    fake = makeConnectorCtx(makeBot());
    host.register(fake.ctx);
    const route = routingOf(host)({ accountId: 'bot-A', peer: { kind: 'direct', id: 'user-9' } });
    sessionKey = route.sessionKey as string;
  });

  function managedFile(content = 'x'): string {
    const dir = getManagedMediaDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `host-test-${Math.random().toString(36).slice(2)}.png`);
    fs.writeFileSync(p, content);
    return p;
  }

  it('单数 MediaPath/MediaType 也形成一条 InboundMediaFile', async () => {
    const p = managedFile();
    await replyOf(host)({
      ctx: { SessionKey: sessionKey, SenderId: 'user-9', BodyForAgent: '看图', MediaPath: p, MediaType: 'image/png' },
      dispatcher: makeDispatcher().dispatcher,
    });
    expect(fake.dispatchWithQueue).toHaveBeenCalledTimes(1);
    const msg = fake.dispatchWithQueue.mock.calls[0][0] as InboundMessage;
    expect(msg.media).toEqual([{ path: p, declaredMediaType: 'image/png' }]);
  });

  it('空 BodyForAgent + MediaPaths 进入 dispatch，不被空消息判断拦截', async () => {
    const p = managedFile();
    await replyOf(host)({
      ctx: { SessionKey: sessionKey, SenderId: 'user-9', BodyForAgent: '', MediaPaths: [p], MediaTypes: ['image/png'] },
      dispatcher: makeDispatcher().dispatcher,
    });
    expect(fake.dispatchWithQueue).toHaveBeenCalledTimes(1);
    const msg = fake.dispatchWithQueue.mock.calls[0][0] as InboundMessage;
    expect(msg.text).toBe('');
    expect(msg.media).toHaveLength(1);
  });

  it('正文与媒体都为空才拒绝：不调 dispatchWithQueue，返回零 counts', async () => {
    const result = await replyOf(host)({
      ctx: { SessionKey: sessionKey, SenderId: 'user-9', BodyForAgent: '' },
      dispatcher: makeDispatcher().dispatcher,
    });
    expect(fake.dispatchWithQueue).not.toHaveBeenCalled();
    expect(result).toEqual({ queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } });
  });

  it('SenderName 透传为 msg.senderName；queuedFinal 只由 counts.final>0 派生', async () => {
    const result = await replyOf(host)({
      ctx: { SessionKey: sessionKey, SenderId: 'user-9', SenderName: '张三', BodyForAgent: 'hi' },
      dispatcher: makeDispatcher().dispatcher,
    });
    const msg = fake.dispatchWithQueue.mock.calls[0][0] as InboundMessage;
    expect(msg.senderName).toBe('张三');
    expect(msg.senderId).toBe('user-9');
    expect(result.queuedFinal).toBe(true);
    expect(result.counts).toEqual({ block: 0, tool: 0, final: 1 });
  });

  it('远程 MediaUrl 先经渠道 saveBuffer 落盘再 dispatch', async () => {
    const png = Buffer.from('89504e47', 'hex');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'image/png; charset=binary' }),
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    })));
    await replyOf(host)({
      ctx: { SessionKey: sessionKey, SenderId: 'user-9', BodyForAgent: '', MediaUrl: 'https://cdn.example/pic.png' },
      dispatcher: makeDispatcher().dispatcher,
    });
    expect(fake.saveBuffer).toHaveBeenCalledTimes(1);
    expect(fake.saveBuffer.mock.calls[0][1]).toBe('image/png');
    expect(fake.dispatchWithQueue).toHaveBeenCalledTimes(1);
    const msg = fake.dispatchWithQueue.mock.calls[0][0] as InboundMessage;
    expect(msg.media).toHaveLength(1);
    expect(msg.media![0].path.startsWith(getManagedMediaDir())).toBe(true);
  });

  it('远程下载失败返回明确媒体失败回执，不降级为无附件文本、不调 dispatch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const { dispatcher, calls, finalPayloads } = makeDispatcher();
    const result = await replyOf(host)({
      ctx: { SessionKey: sessionKey, SenderId: 'user-9', BodyForAgent: '带图消息', MediaUrls: ['https://cdn.example/gone.png'] },
      dispatcher,
    });
    expect(fake.dispatchWithQueue).not.toHaveBeenCalled();
    expect(finalPayloads).toEqual([{ text: MEDIA_READ_FAILED_REPLY }]);
    expect(calls).toEqual(['final', 'markComplete', 'waitForIdle']);
    expect(result.queuedFinal).toBe(true);
  });

  it('下载失败时已落盘的本次受管文件被本地清理（所有权未移交）', async () => {
    const local = managedFile();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await replyOf(host)({
      ctx: { SessionKey: sessionKey, SenderId: 'user-9', BodyForAgent: '', MediaPaths: [local], MediaUrls: ['https://cdn.example/x.png'] },
      dispatcher: makeDispatcher().dispatcher,
    });
    expect(fake.dispatchWithQueue).not.toHaveBeenCalled();
    expect(fs.existsSync(local)).toBe(false);
  });
});

describe('dispatchReplyFromConfig 本地路径分类与越界不读不删', () => {
  let host: OpenClawRuntimeHost;
  let fake: FakeCtx;
  let sessionKey: string;

  beforeEach(() => {
    host = new OpenClawRuntimeHost('feishu');
    fake = makeConnectorCtx(makeBot());
    host.register(fake.ctx);
    const route = routingOf(host)({ accountId: 'bot-A', peer: { kind: 'direct', id: 'user-9' } });
    sessionKey = route.sessionKey as string;
  });

  function managedFile(content = 'x'): string {
    const dir = getManagedMediaDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `host-test-${Math.random().toString(36).slice(2)}.png`);
    fs.writeFileSync(p, content);
    return p;
  }

  function outsideFile(content: string | Buffer = 'y'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-test-vendor-'));
    const p = path.join(dir, `att-${Math.random().toString(36).slice(2)}.png`);
    fs.writeFileSync(p, content);
    return p;
  }

  it('feishu 形状：MediaUrls 装的是与 MediaPaths 相同的本地路径时不 fetch、不重复媒体条目', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('must not fetch local path'); });
    vi.stubGlobal('fetch', fetchSpy);
    const p = managedFile();
    await replyOf(host)({
      ctx: {
        SessionKey: sessionKey, SenderId: 'user-9', BodyForAgent: '',
        MediaPath: p, MediaPaths: [p], MediaTypes: ['image/png'], MediaUrl: p, MediaUrls: [p],
      },
      dispatcher: makeDispatcher().dispatcher,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.dispatchWithQueue).toHaveBeenCalledTimes(1);
    const msg = fake.dispatchWithQueue.mock.calls[0][0] as InboundMessage;
    expect(msg.media).toEqual([{ path: p, declaredMediaType: 'image/png' }]);
  });

  it('非 http(s) 且不在 MediaPaths 的 MediaUrls 条目按本地路径处理，不交给 fetch', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('must not fetch local path'); });
    vi.stubGlobal('fetch', fetchSpy);
    const p = managedFile();
    await replyOf(host)({
      ctx: { SessionKey: sessionKey, SenderId: 'user-9', BodyForAgent: '', MediaUrls: [p] },
      dispatcher: makeDispatcher().dispatcher,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.dispatchWithQueue).toHaveBeenCalledTimes(1);
    const msg = fake.dispatchWithQueue.mock.calls[0][0] as InboundMessage;
    expect(msg.media).toHaveLength(1);
    expect(msg.media![0].path).toBe(p);
  });

  it('受管目录外的本地路径核心层不 stat/readFile/复制/删除，原样移交 Pipeline（越界拒绝单点在 Pipeline）', async () => {
    const vendorPath = outsideFile();
    const readSpy = vi.spyOn(fs.promises, 'readFile');
    const statSpy = vi.spyOn(fs.promises, 'stat');
    try {
      await replyOf(host)({
        ctx: { SessionKey: sessionKey, SenderId: 'user-9', BodyForAgent: '看图', MediaPath: vendorPath, MediaType: 'image/png' },
        dispatcher: makeDispatcher().dispatcher,
      });
      // 核心层不主动读取任意 vendor 路径，原路径交给 Pipeline 做边界校验。
      expect(fake.saveBuffer).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalledWith(vendorPath);
      expect(statSpy).not.toHaveBeenCalledWith(vendorPath);
      expect(fake.dispatchWithQueue).toHaveBeenCalledTimes(1);
      const msg = fake.dispatchWithQueue.mock.calls[0][0] as InboundMessage;
      expect(msg.media).toEqual([{ path: vendorPath, declaredMediaType: 'image/png' }]);
      // 原 vendor 文件生命周期归渠道，绝不删除
      expect(fs.existsSync(vendorPath)).toBe(true);
    } finally {
      readSpy.mockRestore();
      statSpy.mockRestore();
    }
  });

  it('download-failed:// 哨兵路径（渠道下载失败）原样移交，由 Pipeline 读取失败整条拒绝', async () => {
    const staged = managedFile();
    const { dispatcher } = makeDispatcher();
    await replyOf(host)({
      ctx: {
        SessionKey: sessionKey, SenderId: 'user-9', BodyForAgent: '带附件消息',
        MediaPaths: [staged, 'download-failed://file.pdf'], MediaTypes: ['image/png', 'application/octet-stream'],
      },
      dispatcher,
    });
    // 哨兵不是可读文件：核心层不在 dispatch 前尝试读取，整条 MEDIA_READ_FAILED
    // 语义由 Pipeline validateAndConvertInboundMedia 单点强制（见 inbound-media 测试）
    expect(fake.dispatchWithQueue).toHaveBeenCalledTimes(1);
    const msg = fake.dispatchWithQueue.mock.calls[0][0] as InboundMessage;
    expect(msg.media).toEqual([
      { path: staged, declaredMediaType: 'image/png' },
      { path: 'download-failed://file.pdf', declaredMediaType: 'application/octet-stream' },
    ]);
    // 所有权已随 dispatch 移交 Pipeline（本测试的 dispatchWithQueue 是假件，不产生删除）
    expect(fs.existsSync(staged)).toBe(true);
  });

  it('受管目录外超限大文件同样原样移交、绝不读入内存（限额拒绝随越界拒绝由 Pipeline 执行）', async () => {
    const big = outsideFile(Buffer.alloc(MAX_IM_IMAGE_BYTES + 1));
    await replyOf(host)({
      ctx: { SessionKey: sessionKey, SenderId: 'user-9', BodyForAgent: '', MediaPath: big },
      dispatcher: makeDispatcher().dispatcher,
    });
    expect(fake.saveBuffer).not.toHaveBeenCalled();
    expect(fake.dispatchWithQueue).toHaveBeenCalledTimes(1);
    const msg = fake.dispatchWithQueue.mock.calls[0][0] as InboundMessage;
    expect(msg.media![0].path).toBe(big);
    expect(fs.existsSync(big)).toBe(true);
  });

  it('路由缺失早退时清理已落盘受管文件（媒体先规整再早退，不泄漏）', async () => {
    const staged = managedFile();
    const result = await replyOf(host)({
      ctx: { SessionKey: 'agent:no-such-route:feishu:direct:u', SenderId: 'user-9', BodyForAgent: 'x', MediaPaths: [staged] },
      dispatcher: makeDispatcher().dispatcher,
    });
    expect(fake.dispatchWithQueue).not.toHaveBeenCalled();
    expect(result.counts).toEqual({ final: 0, tool: 0, block: 0 });
    expect(fs.existsSync(staged)).toBe(false);
  });
});
