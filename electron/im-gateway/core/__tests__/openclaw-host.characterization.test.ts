/**
 * OpenClawRuntimeHost 特征测试
 *
 * 锁定 vendor 渠道（feishu/qqbot/weixin）消费的宿主能力中应保留的部分：
 * - createReplyDispatcherWithTyping 的帧序/onIdle/onCleanup 语义（feishu 靠 onIdle 停
 *   typing/收尾流式卡片）
 * - loadConfig 的凭证映射：qqbot 使用 clientSecret 字段，其余渠道使用 appSecret；
 *   凭证只投影到 per-account 条目，channel 顶层不再冗余 per-bot 字段
 */

import { describe, it, expect, vi } from 'vitest';


// host 的渠道依赖链需要隔离 electron-store
vi.mock('../../../core/storage/index.js', () => ({
  taskDefinitionStore: { get: () => null },
}));

import { OpenClawRuntimeHost } from '../openclaw-runtime-host.js';
import type { ConnectorContext } from '../channel-connector.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

function fakeCtx(bot: Partial<MessagingConnectionConfig>): ConnectorContext {
  return { bot: bot as MessagingConnectionConfig } as unknown as ConnectorContext;
}

describe('createReplyDispatcherWithTyping（vendor dispatcher 工厂）', () => {
  function buildDispatcher(host: OpenClawRuntimeHost, opts: Record<string, unknown>) {
    const runtime = host.buildRuntime() as {
      channel: { reply: { createReplyDispatcherWithTyping: (o: unknown) => { dispatcher: any; replyOptions: any } } };
    };
    return runtime.channel.reply.createReplyDispatcherWithTyping(opts);
  }

  it('帧按入队顺序串行投递，counts 按 kind 递增', async () => {
    const host = new OpenClawRuntimeHost('feishu');
    const delivered: string[] = [];
    const { dispatcher } = buildDispatcher(host, {
      deliver: async (payload: { text?: string }) => { delivered.push(payload.text!); },
    });

    dispatcher.sendBlockReply({ text: 'a' });
    dispatcher.sendToolResult({ text: 'b' });
    dispatcher.sendFinalReply({ text: 'c' });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(['a', 'b', 'c']);
    expect(dispatcher.getQueuedCounts()).toEqual({ block: 1, tool: 1, final: 1 });
  });

  it('onIdle 在 markComplete 且队列排空后触发（feishu typing 收尾依赖）', async () => {
    const host = new OpenClawRuntimeHost('feishu');
    const onIdle = vi.fn();
    const { dispatcher } = buildDispatcher(host, {
      deliver: async () => {},
      onIdle,
    });

    dispatcher.sendBlockReply({ text: 'x' });
    expect(onIdle).not.toHaveBeenCalled();
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(onIdle).toHaveBeenCalled();
  });

  it('onCleanup 映射到 replyOptions.onTypingCleanup', () => {
    const host = new OpenClawRuntimeHost('feishu');
    const onCleanup = vi.fn();
    const { replyOptions } = buildDispatcher(host, { deliver: async () => {}, onCleanup });
    expect(replyOptions.onTypingCleanup).toBe(onCleanup);
  });
});

describe('loadConfig 凭证映射', () => {
  it('qqbot：clientSecret 字段名，账密只在 per-account 条目（终态，顶层无冗余）', () => {
    const host = new OpenClawRuntimeHost('qqbot');
    host.register(fakeCtx({ id: 'bot-q', appId: 'qq-app', appSecret: 'qq-secret' }));

    const cfg = host.loadConfig() as {
      channels: Record<string, { accounts: Record<string, { appId: string; clientSecret: string }>; appId?: string; clientSecret?: string }>;
    };
    expect(cfg.channels.qqbot.accounts['bot-q']).toEqual({ appId: 'qq-app', clientSecret: 'qq-secret' });
    expect(cfg.channels.qqbot.appId).toBeUndefined();
    expect(cfg.channels.qqbot.clientSecret).toBeUndefined();
  });

  it('feishu：appSecret 字段名，按 bot.id 建 account 条目', () => {
    const host = new OpenClawRuntimeHost('feishu');
    host.register(fakeCtx({ id: 'bot-f1', appId: 'a1', appSecret: 's1' }));
    host.register(fakeCtx({ id: 'bot-f2', appId: 'a2', appSecret: 's2' }));

    const cfg = host.loadConfig() as {
      channels: Record<string, { accounts: Record<string, { appId: string; appSecret: string }> }>;
    };
    expect(cfg.channels.feishu.accounts['bot-f1']).toMatchObject({ appId: 'a1', appSecret: 's1' });
    expect(cfg.channels.feishu.accounts['bot-f2']).toMatchObject({ appId: 'a2', appSecret: 's2' });
  });

  it('unregister 清除 account 与路由缓存', () => {
    const host = new OpenClawRuntimeHost('feishu');
    host.register(fakeCtx({ id: 'bot-f1', appId: 'a1', appSecret: 's1' }));
    host.unregister('bot-f1');
    const cfg = host.loadConfig() as {
      channels: Record<string, { accounts: Record<string, unknown> }>;
    };
    expect(Object.keys(cfg.channels.feishu.accounts)).toHaveLength(0);
  });
});
