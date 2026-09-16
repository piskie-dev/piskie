/**
 * 测试夹具：为内置 IM 渠道创建临时 userData / tmp 根并注入到各 vendor。
 *
 * 与生产路径一致（resolveChannelStoragePaths），用于验证：
 * - 渠道文件全部落在 <userData>/im-gateway/<channel> 与 <tmp>/piskie-im/<channel>
 * - 不触碰 ~/.openclaw、OPENCLAW_* 环境变量指向的外部 OpenClaw 目录
 *
 * 本目录（electron/testing）不参与 Electron 构建。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveChannelStoragePaths, type ChannelStoragePaths } from '../im-gateway/core/channel-storage.js';
import { bindWeixinStorage } from '../im-gateway/channels/weixin/storage.js';
import { bindQQBotStorage } from '../im-gateway/channels/qqbot/storage.js';
import { bindFeishuStorage } from '../im-gateway/channels/feishu/storage.js';

export interface ChannelStorageFixture {
  /** 伪造的 app.getPath('userData') */
  readonly userDataDir: string;
  /** 伪造的 os.tmpdir() */
  readonly tempRoot: string;
  readonly storage: ChannelStoragePaths;
  /** 注入到微信 / QQ / 飞书 vendor（企业微信无存储） */
  bindAll(): void;
  cleanup(): void;
}

export function createChannelStorageFixture(prefix = 'piskie-im-storage-'): ChannelStorageFixture {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}userdata-`));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}tmp-`));
  const storage = resolveChannelStoragePaths(userDataDir, tempRoot);
  return {
    userDataDir,
    tempRoot,
    storage,
    bindAll() {
      bindWeixinStorage(storage);
      bindQQBotStorage(storage);
      bindFeishuStorage(storage);
    },
    cleanup() {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

/** 递归列出目录下所有文件的相对路径（排序），目录不存在时返回 []。 */
export function listFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}
