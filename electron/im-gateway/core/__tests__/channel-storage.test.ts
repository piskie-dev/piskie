import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEISHU_KEYCHAIN_SERVICE, resolveChannelStoragePaths } from '../channel-storage.js';

describe('resolveChannelStoragePaths', () => {
  it('lays every channel out under <userData>/im-gateway and <tmp>/piskie-im', () => {
    const userData = path.join('/fake', 'userData');
    const tmp = path.join('/fake', 'tmp');
    const paths = resolveChannelStoragePaths(userData, tmp);

    expect(paths).toEqual({
      weixinStateDir: path.join(userData, 'im-gateway', 'weixin'),
      weixinTempDir: path.join(tmp, 'piskie-im', 'weixin'),
      qqbotDataDir: path.join(userData, 'im-gateway', 'qqbot'),
      qqbotMediaDir: path.join(userData, 'im-gateway', 'qqbot', 'media'),
      feishuCredentialsDir: path.join(userData, 'im-gateway', 'feishu', 'credentials'),
      feishuKeychainService: 'piskie-feishu-uat',
    });
    expect(FEISHU_KEYCHAIN_SERVICE).toBe('piskie-feishu-uat');
    expect(Object.isFrozen(paths)).toBe(true);
  });

  it('never points at ~/.openclaw or OpenClaw-named locations', () => {
    const paths = resolveChannelStoragePaths('/home/u/.piskie', '/tmp');
    for (const value of Object.values(paths)) {
      expect(value).not.toContain('.openclaw');
      expect(value).not.toContain('openclaw-feishu-uat');
    }
  });
});
