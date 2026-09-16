/**
 * 飞书渠道存储绑定：把宿主给出的 Piskie 专属凭据目录与 Keychain service 注入 vendor 的 token-store。
 *
 * macOS 使用 Keychain service `piskie-feishu-uat`；Linux/Windows 使用
 * `<userData>/im-gateway/feishu/credentials` 下的 AES-256-GCM 加密文件（含独立 master.key）。
 * 不读取、迁移或删除上游 `openclaw-feishu-uat` 位置的旧凭据，用户需重新授权。
 */

import { configureFeishuTokenStore } from './vendor/src/core/token-store-location.js';
import type { ChannelStoragePaths } from '../../core/channel-storage.js';

export function bindFeishuStorage(storage: ChannelStoragePaths): void {
  configureFeishuTokenStore({
    credentialsDir: storage.feishuCredentialsDir,
    keychainService: storage.feishuKeychainService,
  });
}
