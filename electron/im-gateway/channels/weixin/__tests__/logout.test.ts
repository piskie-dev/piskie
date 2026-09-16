import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 一个"外部 OpenClaw"状态目录：退出登录绝不能读取、迁移或删除其中的旧数据。
const externalState = await vi.hoisted(async () => {
  const nodeOs = await import('node:os');
  const fsModule = await import('node:fs');
  const pathModule = await import('node:path');
  const stateDir = fsModule.mkdtempSync(pathModule.join(nodeOs.tmpdir(), 'weixin-logout-external-'));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return { stateDir };
});

vi.mock('../../../../core/storage/index.js', () => ({
  taskDefinitionStore: { get: vi.fn(() => null) },
}));

import { createWeixinConnector } from '../index.js';
import { createChannelStorageFixture, listFilesRecursive } from '@electron/testing/im-channel-storage.fixture.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

const fixture = createChannelStorageFixture('weixin-logout-');
const { storage } = fixture;
const weixinRoot = storage.weixinStateDir;
const accountDir = path.join(weixinRoot, 'accounts');
const authorizationDir = path.join(weixinRoot, 'authorization');

function bot(overrides: Partial<MessagingConnectionConfig> = {}): MessagingConnectionConfig {
  return {
    id: 'bot-logout',
    name: 'Weixin',
    channelType: 'openclaw-weixin',
    definitionId: 'td-1',
    appId: '',
    appSecret: '',
    ...overrides,
  };
}

beforeEach(() => {
  fs.rmSync(weixinRoot, { recursive: true, force: true });
  fs.mkdirSync(accountDir, { recursive: true });
  fs.mkdirSync(authorizationDir, { recursive: true });
});

afterAll(() => {
  fixture.cleanup();
  fs.rmSync(externalState.stateDir, { recursive: true, force: true });
});

describe('Weixin local logout', () => {
  it('clears account file, sync cursor, context tokens, allowFrom list and account index under the Piskie weixin root', async () => {
    // 文件按规整后的账号 ID 命名（real@im.bot → real-im-bot），不再有 raw-ID 回退
    for (const suffix of ['.json', '.sync.json', '.context-tokens.json']) {
      fs.writeFileSync(path.join(accountDir, `real-im-bot${suffix}`), '{}', 'utf8');
    }
    fs.writeFileSync(path.join(authorizationDir, 'real-im-bot-allowFrom.json'), JSON.stringify({ version: 1, allowFrom: ['u1'] }), 'utf8');
    fs.writeFileSync(path.join(weixinRoot, 'accounts.json'), JSON.stringify(['real-im-bot']), 'utf8');

    const connector = createWeixinConnector(storage)(bot({ pluginAccountId: 'real@im.bot' }));
    await expect(connector.logoutAccount?.({ accountId: 'bot-logout' }))
      .resolves.toMatchObject({ cleared: true });

    expect(fs.readdirSync(accountDir)).toEqual([]);
    expect(fs.readdirSync(authorizationDir)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(weixinRoot, 'accounts.json'), 'utf8'))).toEqual([]);
  });

  it('leaves other accounts untouched and is idempotent when nothing exists', async () => {
    fs.writeFileSync(path.join(accountDir, 'other-im-bot.json'), '{"token":"o"}', 'utf8');
    fs.writeFileSync(path.join(weixinRoot, 'accounts.json'), JSON.stringify(['other-im-bot', 'real-im-bot']), 'utf8');

    const connector = createWeixinConnector(storage)(bot({ pluginAccountId: 'real@im.bot' }));
    await connector.logoutAccount?.({ accountId: 'bot-logout' });
    await connector.logoutAccount?.({ accountId: 'bot-logout' });

    expect(fs.readdirSync(accountDir)).toEqual(['other-im-bot.json']);
    expect(JSON.parse(fs.readFileSync(path.join(weixinRoot, 'accounts.json'), 'utf8'))).toEqual(['other-im-bot']);
  });

  it('never reads, migrates or deletes legacy data in an external OpenClaw state dir', async () => {
    const legacyCredential = path.join(externalState.stateDir, 'credentials', 'openclaw-weixin', 'credentials.json');
    const legacySync = path.join(externalState.stateDir, 'agents', 'default', 'sessions', '.openclaw-weixin-sync', 'default.json');
    const legacyAccount = path.join(externalState.stateDir, 'openclaw-weixin', 'accounts', 'real-im-bot.json');
    for (const file of [legacyCredential, legacySync, legacyAccount]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ token: 'legacy' }), 'utf8');
    }
    const before = listFilesRecursive(externalState.stateDir);

    const connector = createWeixinConnector(storage)(bot({ pluginAccountId: 'real@im.bot' }));
    await connector.logoutAccount?.({ accountId: 'bot-logout' });

    expect(listFilesRecursive(externalState.stateDir)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(legacyCredential, 'utf8'))).toEqual({ token: 'legacy' });
    // 也没有把旧数据"顺手"迁进 Piskie 根
    expect(listFilesRecursive(weixinRoot)).toEqual([]);
    expect(fs.existsSync(path.join(os.homedir(), '.openclaw', 'openclaw-weixin', 'accounts', 'real-im-bot.json'))).toBe(false);
  });
});
