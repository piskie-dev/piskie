# 微信个人号渠道：上游来源与本地适配

- 源包：`@tencent-weixin/openclaw-weixin@2.4.6`（MIT，Tencent）
- 收编日期：2026-07-20
- tarball SHA-256：`ef1c3600ca2fc0ee9076c1327af1e0d5d2e8e19fbb61e9f56c961fcde0bd07f6`
- 基线内容：npm tarball 的 `dist/src/**/*.js`，共 35 个 JS 文件

## 收编规则

1. 删除旧 `vendor/src` 后复制上游 2.4.6 的 35 个 `dist/src/**/*.js`，不混用旧文件。
2. 不收编 `dist/index.js`；PISKIE 继续通过自己的 channel registry 装配 connector。
3. 删除 sourcemap 文件和尾部 `sourceMappingURL`，保留明文 ESM JS。
4. `runtime.js/runtime.d.ts` 已随新版删除；runtime 与 `channelRuntime` 由 connector 按次注入。
5. `vendor/package.json` 是运行时协议元数据，构建时必须复制到同构的 `dist-electron` 路径。
6. `channel.d.ts`、`auth/accounts.d.ts`、`messaging/inbound.d.ts` 是 PISKIE 手写的最小类型边界。

## 必须重放的本地差异

| 能力 | 文件 | PISKIE 适配 |
|---|---|---|
| OpenClaw compat | `channel.js`、`auth/*`、`messaging/process-message.js`、`util/logger.js` | 裸 `openclaw/plugin-sdk/*` import 改到 `core/openclaw-compat`；生产闭包不得残留裸依赖 |
| 全局 hooks | `messaging/outbound-hooks.js` | 保留函数签名，`message_sending/message_sent` 固定 no-op；不引入完整 OpenClaw hook runtime |
| 配置 reload | `auth/accounts.js` | `triggerWeixinChannelReload()` 固定 no-op；账号映射由 PISKIE `BotConfig.pluginAccountId` 持久化 |
| Runtime | `index.ts`、`runtime-adapter.ts` | `register -> buildRuntime -> startAccount(runtime, channelRuntime)`；pre-abort 零网络；finally 有界 stop 后 unregister |
| Sender 身份 | `messaging/process-message.js` | 设置真实 `ctx.SenderId`，供核心发送者校验使用 |
| 入站媒体安全 | `media/media-download.js`、`cdn/pic-decrypt.js`、`messaging/process-message.js` | 20 MiB 上限、120 秒 CDN 上限、四类 `download-failed://` 哨兵、dispatch 前清理/调用后 handoff |
| Connector abort | `api/*`、`monitor/*`、`messaging/*`、`cdn/*` | 统一字段 `abortSignal`；取消长轮询、配置请求、发送、上传下载和退避；abort 后不再 dispatch 剩余消息 |
| 发送正确性 | `api/api.js`、`messaging/send.js` | 不设置 `Content-Length`；校验 HTTP 与 `ret/errmsg`；网络/超时/408/425/429/5xx 按 1/3/10 秒重试，同一次重试复用 `client_id/run_id` |
| 原生工具进度 | `messaging/process-message.js` | 不使用上游 `onItemEvent/WeixinReplyProgressSender`；由 PISKIE dispatcher 的同一 sendChain 发送 type 11/12 |
| run_id | `messaging/process-message.js`、`messaging/send*.js` | 每条普通入站创建一个 run，文本、媒体、工具和迟到多轮输出共用；新 dispatcher 创建新 run |
| 在线通知 | `channel.js`、`api/api.js` | `notifyStart` 使用 Connector signal + 2 秒上限；`notifyStop` 使用独立 2 秒硬超时并在 connector settle 前等待 |
| GUI QR | `auth/login-qr.js`、`channel.js` | 禁止 stdin；验证码 continuation、取消、过期、blocked、alreadyConnected 显式返回；新 Bot 不上传其他账号 token |
| 本地 logout | `auth/accounts.js`、`index.ts` | 清 normalized/raw account、context、sync、index；仅在 legacy 凭证确为来源时清 legacy credential/cursor |

## re-vendor 流程

1. `npm pack @tencent-weixin/openclaw-weixin@<version>`，校验包名、版本、LICENSE 和摘要。
2. 干净替换 `vendor/src` 为 tarball 的 `dist/src/**/*.js`，确认 JS 文件清单和数量。
3. 更新 `vendor/package.json` 与 LICENSE，删除 map/runtime 残余。
4. 重写 compat import，并恢复 no-op hook/config reload 边界。
5. 按上表逐项重放媒体、abort、重试、工具、QR、通知和 logout 适配。
6. 运行 vendor 完整性、类型检查、微信特征测试、四渠道回归、Electron 构建和真机长工具链验收。

账号、context token 和 sync buf 的磁盘格式沿用上游，升级不得要求既有用户重新扫码。
