/**
 * 微信渠道存储绑定：把宿主给出的 Piskie 专属目录注入 vendor 的 state-dir 模块。
 *
 * 长期连接、扫码登录与退出登录的临时 Connector 都经 createWeixinConnector 走这里，
 * 保证所有账号/游标/授权/调试开关/出站临时文件落在同一根目录，且不触碰 ~/.openclaw。
 */

import { configureWeixinStorage } from './vendor/src/storage/state-dir.js';
import type { ChannelStoragePaths } from '../../core/channel-storage.js';

export function bindWeixinStorage(storage: ChannelStoragePaths): void {
  configureWeixinStorage({ stateDir: storage.weixinStateDir, tempDir: storage.weixinTempDir });
}
