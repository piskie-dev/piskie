/**
 * 内置 IM 渠道存储隔离（docs/im-channel-storage-isolation-proposal.md §7）
 *
 * - 模块导入不创建任何目录；未注入存储位置前 vendor 路径解析直接抛错
 * - 注入后，微信 / QQ / 飞书的所有落盘都在 <userData>/im-gateway/<channel>
 * - OPENCLAW_* / QQBOT_IMAGE_SERVER_DIR / XDG_DATA_HOME / HOME 指向的"外部 OpenClaw"
 *   目录全程不被读取、迁移或写入
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';

const external = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'im-isolation-external-'));
  const home = nodePath.join(root, 'home');
  const stateDir = nodePath.join(root, 'openclaw-state');
  const oauthDir = nodePath.join(root, 'openclaw-oauth');
  const imageDir = nodePath.join(root, 'qqbot-image-server');
  const xdgData = nodePath.join(root, 'xdg-data');
  const configPath = nodePath.join(root, 'openclaw.json');
  const seed = (file: string, content: string) => {
    nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
    nodeFs.writeFileSync(file, content, 'utf8');
  };
  // 一套看起来"可用"的外部 OpenClaw 数据：若任何回退/迁移分支残留，就会读到或改动这些文件
  seed(nodePath.join(stateDir, 'openclaw-weixin', 'accounts.json'), JSON.stringify(['ext-im-bot']));
  seed(nodePath.join(stateDir, 'openclaw-weixin', 'accounts', 'ext-im-bot.json'), JSON.stringify({ token: 'ext-token' }));
  seed(nodePath.join(stateDir, 'openclaw-weixin', 'accounts', 'acct-1.json'), JSON.stringify({ token: 'ext-token-acct-1' }));
  seed(nodePath.join(stateDir, 'credentials', 'openclaw-weixin', 'credentials.json'), JSON.stringify({ token: 'legacy' }));
  seed(nodePath.join(oauthDir, 'openclaw-weixin-acct-1-allowFrom.json'), JSON.stringify({ version: 1, allowFrom: ['ext-user'] }));
  seed(configPath, JSON.stringify({ channels: { 'openclaw-weixin': { botAgent: 'external-agent', routeTag: 'ext-route' } } }));
  seed(nodePath.join(home, '.openclaw', 'qqbot', 'data', 'known-users.json'), '{}');
  seed(nodePath.join(home, '.openclaw', 'qqbot', 'data', 'admin-qq-1.json'), JSON.stringify({ openid: 'legacy-admin' }));
  seed(nodePath.join(home, '.openclaw', 'qqbot', 'data', 'startup-marker.json'), JSON.stringify({ version: '0.0.1' }));
  seed(nodePath.join(home, '.openclaw', 'media', 'qqbot', 'downloads', 'app-1', 'old.png'), 'old');
  seed(nodePath.join(imageDir, 'ext.png'), 'ext');
  seed(nodePath.join(xdgData, 'openclaw-feishu-uat', 'master.key'), 'k'.repeat(32));
  seed(nodePath.join(xdgData, 'openclaw-feishu-uat', 'app-1_ou_1.enc'), 'enc');

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.CLAWDBOT_STATE_DIR = stateDir;
  process.env.OPENCLAW_OAUTH_DIR = oauthDir;
  process.env.OPENCLAW_CONFIG = configPath;
  process.env.QQBOT_IMAGE_SERVER_DIR = imageDir;
  process.env.XDG_DATA_HOME = xdgData;
  return { root, home, stateDir, oauthDir, imageDir, xdgData, configPath };
});

import { createChannelStorageFixture, listFilesRecursive } from '@electron/testing/im-channel-storage.fixture.js';
// ── weixin vendor（ESM）
import { resolveStateDir, resolveWeixinTempDir } from '../weixin/vendor/src/storage/state-dir.js';
import {
  loadConfigBotAgent, loadConfigRouteTag, loadWeixinAccount, listIndexedWeixinAccountIds,
  registerWeixinAccountId, saveWeixinAccount,
} from '../weixin/vendor/src/auth/accounts.js';
import { readFrameworkAllowFromList, registerUserInFrameworkStore, resolveFrameworkAllowFromPath } from '../weixin/vendor/src/auth/pairing.js';
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from '../weixin/vendor/src/storage/sync-buf.js';
import { setContextToken } from '../weixin/vendor/src/messaging/inbound.js';
import { isDebugMode, toggleDebugMode } from '../weixin/vendor/src/messaging/debug-mode.js';
// ── qqbot vendor（ESM）
import { getQQBotDataDir, getQQBotMediaDir, resolveQQBotMediaDir } from '../qqbot/vendor/src/utils/platform.js';
import { loadSession, saveSession } from '../qqbot/vendor/src/session-store.js';
import { flushKnownUsers, listKnownUsers, recordKnownUser } from '../qqbot/vendor/src/known-users.js';
import { getRefIndex, setRefIndex } from '../qqbot/vendor/src/ref-index-store.js';
import { loadAdminOpenId, saveAdminOpenId } from '../qqbot/vendor/src/admin-resolver.js';
import { readStartupMarker, writeStartupMarker } from '../qqbot/vendor/src/startup-greeting.js';
// ── feishu vendor（CJS，经 ESM import 与 Node require 均可见同一 globalThis 状态）
import { requireFeishuTokenStoreLocation } from '../feishu/vendor/src/core/token-store-location.js';

const fixture = createChannelStorageFixture('im-isolation-');
const { storage } = fixture;

interface Snapshot { files: string[]; contents: Record<string, string> }
function snapshot(root: string): Snapshot {
  const files = listFilesRecursive(root);
  const contents: Record<string, string> = {};
  for (const file of files) contents[file] = fs.readFileSync(path.join(root, file), 'utf8');
  return { files, contents };
}

let externalBefore: Snapshot;

beforeAll(() => {
  externalBefore = snapshot(external.root);
});

afterAll(() => {
  fixture.cleanup();
  fs.rmSync(external.root, { recursive: true, force: true });
});

describe('模块初始化不落盘、未注入即拒绝', () => {
  it('importing every vendor storage module creates nothing under userData and throws before configure', () => {
    expect(fs.existsSync(path.join(fixture.userDataDir, 'im-gateway'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.tempRoot, 'piskie-im'))).toBe(false);
    expect(() => resolveStateDir()).toThrow(/configureWeixinStorage/);
    expect(() => resolveWeixinTempDir()).toThrow(/configureWeixinStorage/);
    expect(() => getQQBotDataDir('sessions')).toThrow(/configureQQBotStorage/);
    expect(() => getQQBotMediaDir()).toThrow(/configureQQBotStorage/);
    expect(() => requireFeishuTokenStoreLocation()).toThrow(/configureFeishuTokenStore/);
    // 导入过程没有碰外部目录
    expect(snapshot(external.root)).toEqual(externalBefore);
  });
});

describe('注入后所有落盘位于 Piskie 专属根', () => {
  beforeAll(() => fixture.bindAll());

  it('weixin: accounts / sync cursor / context tokens / allowFrom / debug-mode live under im-gateway/weixin', async () => {
    const root = storage.weixinStateDir;
    expect(resolveStateDir()).toBe(root);
    expect(resolveWeixinTempDir()).toBe(path.join(fixture.tempRoot, 'piskie-im', 'weixin'));

    saveWeixinAccount('acct-1', { token: 'piskie-token', baseUrl: '', userId: 'user-1' });
    registerWeixinAccountId('acct-1');
    saveGetUpdatesBuf(getSyncBufFilePath('acct-1'), 'cursor-1');
    setContextToken('acct-1', 'user-1', 'ctx-1');
    await registerUserInFrameworkStore({ accountId: 'acct-1', userId: 'user-1' });
    toggleDebugMode('acct-1');

    expect(listFilesRecursive(root)).toEqual([
      'accounts.json',
      'accounts/acct-1.context-tokens.json',
      'accounts/acct-1.json',
      'accounts/acct-1.sync.json',
      'authorization/acct-1-allowFrom.json',
      'debug-mode.json',
    ]);
    expect(resolveFrameworkAllowFromPath('acct-1')).toBe(path.join(root, 'authorization', 'acct-1-allowFrom.json'));
    expect(loadWeixinAccount('acct-1')).toMatchObject({ token: 'piskie-token', userId: 'user-1' });
    expect(listIndexedWeixinAccountIds()).toEqual(['acct-1']);
    expect(loadGetUpdatesBuf(getSyncBufFilePath('acct-1'))).toBe('cursor-1');
    expect(readFrameworkAllowFromList('acct-1')).toEqual(['user-1']);
    expect(isDebugMode('acct-1')).toBe(true);
  });

  it('weixin: external OpenClaw accounts/config are invisible (no raw-ID, legacy token or openclaw.json fallback)', () => {
    // 外部 state dir 里有 ext-im-bot 与 legacy credentials.json，Piskie 根里没有 → 一律视为未登录
    expect(loadWeixinAccount('ext-im-bot')).toBeNull();
    expect(loadWeixinAccount('ext@im.bot')).toBeNull();
    expect(listIndexedWeixinAccountIds()).not.toContain('ext-im-bot');
    // OPENCLAW_CONFIG 指向的 openclaw.json 不再被读取
    expect(loadConfigBotAgent()).toBeUndefined();
    expect(loadConfigRouteTag('acct-1')).toBeUndefined();
    // OPENCLAW_OAUTH_DIR 中的 allowFrom 不再被读取（Piskie 根里只有本测试写入的 user-1）
    expect(readFrameworkAllowFromList('acct-1')).toEqual(['user-1']);
  });

  it('qqbot: sessions / data / images / media live under im-gateway/qqbot; legacy markers are ignored', () => {
    const root = storage.qqbotDataDir;
    expect(getQQBotDataDir()).toBe(root);
    expect(getQQBotDataDir('images')).toBe(path.join(root, 'images'));
    expect(getQQBotMediaDir('downloads', 'app-1')).toBe(path.join(root, 'media', 'downloads', 'app-1'));
    expect(resolveQQBotMediaDir('downloads', 'app-1')).toBe(path.join(root, 'media', 'downloads', 'app-1'));

    saveSession({ accountId: 'qq-1', appId: 'app-1', sessionId: 'sess-1', lastSeq: 7 });
    recordKnownUser({ accountId: 'qq-1', openid: 'ou-1', type: 'c2c' });
    flushKnownUsers();
    setRefIndex('REFIDX_1', { content: 'hello', senderId: 'ou-1', senderName: 'A', timestamp: Date.now(), isBot: false });
    saveAdminOpenId('qq-1', 'app-1', 'ou-admin');
    writeStartupMarker('qq-1', 'app-1', { version: '9.9.9' });

    const files = listFilesRecursive(root);
    expect(files).toContain('data/known-users.json');
    expect(files).toContain('data/ref-index.jsonl');
    expect(files).toContain('data/admin-qq-1-app-1.json');
    expect(files).toContain('data/startup-marker-qq-1-app-1.json');
    expect(files.some((file) => file.startsWith('sessions/'))).toBe(true);
    expect(files.every((file) => !file.includes('.openclaw'))).toBe(true);

    expect(loadSession('qq-1', 'app-1')).toMatchObject({ sessionId: 'sess-1', lastSeq: 7 });
    expect(listKnownUsers({ accountId: 'qq-1', type: 'c2c' }).map((u: { openid: string }) => u.openid)).toEqual(['ou-1']);
    expect(getRefIndex('REFIDX_1')).toMatchObject({ content: 'hello' });
    expect(loadAdminOpenId('qq-1', 'app-1')).toBe('ou-admin');
    expect(readStartupMarker('qq-1', 'app-1')).toEqual({ version: '9.9.9' });
    // ~/.openclaw 里的 admin-qq-1.json / startup-marker.json 不被当作回退，也不被迁移
    expect(loadAdminOpenId('qq-2', 'app-1')).toBeUndefined();
    expect(readStartupMarker('qq-2', 'app-1')).toEqual({});
  });

  it('qqbot: gateway image server dir ignores QQBOT_IMAGE_SERVER_DIR and session store bypass is gone', () => {
    // 这两个入口是 gateway.js 内部函数，无法直接调用：按调用链检查其源码不再引用外部路径
    const gatewaySource = fs.readFileSync(path.join(__dirname, '..', 'qqbot', 'vendor', 'src', 'gateway.js'), 'utf8');
    expect(gatewaySource).not.toContain('process.env.QQBOT_IMAGE_SERVER_DIR');
    expect(gatewaySource).not.toContain('resolveSessionStorePath');
    expect(gatewaySource).not.toContain('process.env.OPENCLAW_STATE_DIR');
    expect(gatewaySource).not.toContain('process.env.CLAWDBOT_STATE_DIR');
    expect(listFilesRecursive(external.imageDir)).toEqual(['ext.png']);
  });

  it.skipIf(process.platform !== 'linux')('feishu: Linux encrypted-file backend writes master.key and .enc under im-gateway/feishu/credentials', async () => {
    const req = createRequire(__filename);
    // 经 Node require 加载（与 vendor 内部 require 同实例），验证 globalThis 注入对两侧都生效
    const tokenStore = req('../feishu/vendor/src/core/token-store.js') as {
      setStoredToken(token: Record<string, unknown>): Promise<void>;
      getStoredToken(appId: string, userOpenId: string): Promise<Record<string, unknown> | null>;
      removeStoredToken(appId: string, userOpenId: string): Promise<void>;
    };
    expect(requireFeishuTokenStoreLocation()).toEqual({
      credentialsDir: storage.feishuCredentialsDir,
      keychainService: 'piskie-feishu-uat',
    });
    const token = {
      appId: 'app-1', userOpenId: 'ou_1', accessToken: 'at-123456789', refreshToken: 'rt-1',
      expiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 86_400_000,
    };
    await tokenStore.setStoredToken(token);
    expect(listFilesRecursive(storage.feishuCredentialsDir)).toEqual(['app-1_ou_1.enc', 'master.key']);
    expect(fs.statSync(path.join(storage.feishuCredentialsDir, 'master.key')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(storage.feishuCredentialsDir, 'app-1_ou_1.enc')).mode & 0o777).toBe(0o600);
    // 密文不含明文 token
    expect(fs.readFileSync(path.join(storage.feishuCredentialsDir, 'app-1_ou_1.enc')).includes('at-123456789')).toBe(false);
    expect(await tokenStore.getStoredToken('app-1', 'ou_1')).toEqual(token);
    // 新根自己生成 master.key，与 XDG 旧目录里的 key 无关
    expect(fs.readFileSync(path.join(storage.feishuCredentialsDir, 'master.key')).equals(Buffer.from('k'.repeat(32)))).toBe(false);
    await tokenStore.removeStoredToken('app-1', 'ou_1');
    expect(listFilesRecursive(storage.feishuCredentialsDir)).toEqual(['master.key']);
  });

  it('nothing under the external OpenClaw dirs or ~/.openclaw was read into Piskie, changed or deleted', () => {
    expect(snapshot(external.root)).toEqual(externalBefore);
    // 也没有在假 HOME 下新建任何 OpenClaw 目录
    expect(listFilesRecursive(path.join(external.home, '.openclaw'))).toEqual(
      externalBefore.files.filter((file) => file.startsWith('home/.openclaw/')).map((file) => file.slice('home/.openclaw/'.length)),
    );
    // Piskie 侧的所有文件都在 im-gateway 下
    const piskieFiles = listFilesRecursive(fixture.userDataDir);
    expect(piskieFiles.length).toBeGreaterThan(0);
    expect(piskieFiles.every((file) => file.startsWith('im-gateway/'))).toBe(true);
  });
});
