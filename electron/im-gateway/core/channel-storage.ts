/**
 * ChannelStoragePaths — 内置 IM 渠道的 Piskie 专属存储位置
 *
 * 各渠道 vendor 协议代码收编自独立 OpenClaw 插件，原本把凭据、状态、临时文件
 * 写进 `~/.openclaw`、OpenClaw 临时目录或 `openclaw-feishu-uat` 凭据命名空间。
 * 与同机独立 OpenClaw 共用这些位置会互相覆盖状态、混写日志，甚至在退出账号时
 * 删除另一程序的数据。本模块由宿主的 `userData` 与系统临时目录集中计算出每个
 * 渠道自己的根，再作为渠道工厂依赖注入 vendor，vendor 内不再推导用户主目录或
 * 读取 OpenClaw 环境变量。
 *
 * 目录约定（见 docs/im-channel-storage-isolation-proposal.md §3）：
 *   <userData>/im-gateway/weixin/               微信账号索引、凭据、游标、授权、debug 状态
 *   <userData>/im-gateway/qqbot/                QQ sessions/data/images/tts
 *   <userData>/im-gateway/qqbot/media/          QQ 语音与出站下载
 *   <userData>/im-gateway/feishu/credentials/   飞书 UAT 加密凭据（Linux/Windows）
 *   <os.tmpdir()>/piskie-im/<channel>/          出站下载、转换等可丢弃临时文件
 *
 * 不做旧数据迁移：新目录为空时按现有流程重新扫码/授权。
 */

import os from 'node:os';
import path from 'node:path';

export interface ChannelStoragePaths {
  /** 微信账号索引、账号凭据、同步游标、context token、授权名单与 debug 状态根 */
  readonly weixinStateDir: string;
  /** 微信出站媒体下载/转换临时目录 */
  readonly weixinTempDir: string;
  /** QQ 普通数据根（sessions/、data/、images/、tts/ 的父目录） */
  readonly qqbotDataDir: string;
  /** QQ 语音与出站下载媒体根 */
  readonly qqbotMediaDir: string;
  /** 飞书 UAT 加密凭据目录（Linux / Windows 文件后端） */
  readonly feishuCredentialsDir: string;
  /** 飞书 UAT macOS 钥匙串 service 名 */
  readonly feishuKeychainService: string;
}

export const FEISHU_KEYCHAIN_SERVICE = 'piskie-feishu-uat';

/** 由宿主 userData 与系统临时目录计算各渠道的 Piskie 专属存储位置。 */
export function resolveChannelStoragePaths(
  userDataDir: string,
  tempRoot: string = os.tmpdir(),
): ChannelStoragePaths {
  const gatewayRoot = path.join(userDataDir, 'im-gateway');
  const tempBase = path.join(tempRoot, 'piskie-im');
  const qqbotDataDir = path.join(gatewayRoot, 'qqbot');
  return Object.freeze({
    weixinStateDir: path.join(gatewayRoot, 'weixin'),
    weixinTempDir: path.join(tempBase, 'weixin'),
    qqbotDataDir,
    qqbotMediaDir: path.join(qqbotDataDir, 'media'),
    feishuCredentialsDir: path.join(gatewayRoot, 'feishu', 'credentials'),
    feishuKeychainService: FEISHU_KEYCHAIN_SERVICE,
  });
}
