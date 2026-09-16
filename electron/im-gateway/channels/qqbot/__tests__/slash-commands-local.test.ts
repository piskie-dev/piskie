/**
 * QQ 插件级斜杠指令的"旁路"分支已改为 Piskie 本地语义：
 * - /bot-upgrade 不再探测/升级外部 OpenClaw，返回"QQ 组件随 Piskie 更新"
 * - /bot-logs 不再扫描/导出外部 OpenClaw 日志目录
 * - /bot-clear-storage 清理 Piskie 注入的 QQ 媒体根，不碰 ~/.openclaw/media
 * - getFrameworkVersion 不再执行外部 CLI
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const sandbox = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  const home = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'qqbot-slash-home-'));
  const legacyDownload = nodePath.join(home, '.openclaw', 'media', 'qqbot', 'downloads', 'app-1', 'legacy.bin');
  nodeFs.mkdirSync(nodePath.dirname(legacyDownload), { recursive: true });
  nodeFs.writeFileSync(legacyDownload, 'legacy');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { home, legacyDownload };
});

import { getFrameworkVersion, matchSlashCommand } from '../vendor/src/slash-commands.js';
import { setQQBotRuntime } from '../vendor/src/runtime.js';
import { createChannelStorageFixture, listFilesRecursive } from '@electron/testing/im-channel-storage.fixture.js';

const fixture = createChannelStorageFixture('qqbot-slash-');
beforeAll(() => fixture.bindAll());
afterAll(() => {
  fixture.cleanup();
  fs.rmSync(sandbox.home, { recursive: true, force: true });
});

function ctx(rawContent: string, type: 'c2c' | 'group' = 'c2c') {
  return {
    rawContent, type, appId: 'app-1', accountId: 'qq-1', args: '',
    eventTimestamp: new Date().toISOString(), receivedAt: Date.now(), accountConfig: {},
  };
}

describe('QQ slash commands without external OpenClaw', () => {
  it('/bot-upgrade returns the local note instead of probing or upgrading an OpenClaw install', async () => {
    const reply = await matchSlashCommand(ctx('/bot-upgrade --latest'));
    expect(String(reply)).toContain('QQ 组件随 Piskie 更新');
    expect(String(reply)).not.toMatch(/openclaw upgrade|热更新|npm/i);
  });

  it('/bot-logs points at the Piskie app log instead of exporting external OpenClaw log files', async () => {
    const reply = await matchSlashCommand(ctx('/bot-logs'));
    expect(String(reply)).toContain('Piskie 应用日志');
    expect(reply).not.toHaveProperty('filePath');
  });

  it('/bot-clear-storage scans and clears only the injected QQ media dir', async () => {
    const target = path.join(fixture.storage.qqbotMediaDir, 'downloads', 'app-1');
    fs.mkdirSync(path.join(target, 'peer-1'), { recursive: true });
    fs.writeFileSync(path.join(target, 'peer-1', 'a.png'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(target, 'b.txt'), 'hello');

    const preview = String(await matchSlashCommand(ctx('/bot-clear-storage')));
    expect(preview).toContain('im-gateway/qqbot/media/downloads/app-1');
    expect(preview).toContain('总共 2 个文件');
    expect(preview).not.toContain('.openclaw');
    expect(listFilesRecursive(target)).toEqual(['b.txt', 'peer-1/a.png']);

    const result = String(await matchSlashCommand(ctx('/bot-clear-storage --force')));
    expect(result).toContain('已删除 2 个文件');
    expect(listFilesRecursive(target)).toEqual([]);
    // ~/.openclaw/media/qqbot 中的旧文件不受影响
    expect(fs.existsSync(sandbox.legacyDownload)).toBe(true);

    expect(await matchSlashCommand(ctx('/bot-clear-storage', 'group'))).toContain('私聊');
  });

  it('getFrameworkVersion reads the injected runtime version and never shells out', () => {
    expect(getFrameworkVersion()).toBe('unknown');
    setQQBotRuntime({ version: '2026.3.24' } as never);
    expect(getFrameworkVersion()).toBe('2026.3.24');
  });
});
