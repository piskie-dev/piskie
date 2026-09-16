/**
 * QQ 渠道存储绑定：把宿主给出的 Piskie 专属目录注入 vendor 的 utils/platform 模块。
 *
 * 数据根 `<userData>/im-gateway/qqbot`（sessions/、data/、images/），媒体根为其 `media/` 子目录；
 * 所有 vendor 存储模块都惰性调用 getQQBotDataDir/getQQBotMediaDir，模块导入不创建目录。
 */

import { configureQQBotStorage } from './vendor/src/utils/platform.js';
import type { ChannelStoragePaths } from '../../core/channel-storage.js';

export function bindQQBotStorage(storage: ChannelStoragePaths): void {
  configureQQBotStorage({ dataDir: storage.qqbotDataDir, mediaDir: storage.qqbotMediaDir });
}
