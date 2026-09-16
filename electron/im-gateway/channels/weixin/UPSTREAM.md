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
| 入站媒体安全 | `media/media-download.js`、`cdn/pic-decrypt.js`、`messaging/process-message.js` | 按原序下载全部媒体；单图 5 MiB（密文允许 padding）、120 秒 CDN 上限、`download-failed://` 哨兵、dispatch 前清理/调用后 handoff；公共层校验 10 张/合计 20 MiB |
| 工具图片发送 | `messaging/process-message.js`、`cdn/upload.js`、`cdn/cdn-upload.js` | 原 `deliver` 完整消费 `mediaUrls`，复用公共 `sendImageBatch` 的预算和有界读取，传 Buffer 给现有原生上传；逐图加密上传/发图，沿用账号、context token 和 run；等待失败通知，取消与上传超时生效，清理远程媒体临时文件 |
| 媒体日志 | `messaging/process-message.js`、`media/media-download.js`、`cdn/pic-decrypt.js` | 媒体上下文改记数量、大小和阶段，不打印整份 payload、媒体 URL 或 AES key |
| Connector abort | `api/*`、`monitor/*`、`messaging/*`、`cdn/*` | 统一字段 `abortSignal`；取消长轮询、配置请求、发送、上传下载和退避；abort 后不再 dispatch 剩余消息 |
| 发送正确性 | `api/api.js`、`messaging/send.js` | 不设置 `Content-Length`；校验 HTTP 与 `ret/errmsg`；网络/超时/408/425/429/5xx 按 1/3/10 秒重试，同一次重试复用 `client_id/run_id` |
| 原生工具进度 | `messaging/process-message.js` | 不使用上游 `onItemEvent/WeixinReplyProgressSender`；由 PISKIE dispatcher 的同一 sendChain 发送 type 11/12 |
| run_id | `messaging/process-message.js`、`messaging/send*.js` | 每条普通入站创建一个 run，文本、媒体、工具和迟到多轮输出共用；新 dispatcher 创建新 run |
| 在线通知 | `channel.js`、`api/api.js` | `notifyStart` 使用 Connector signal + 2 秒上限；`notifyStop` 使用独立 2 秒硬超时并在 connector settle 前等待 |
| GUI QR | `auth/login-qr.js`、`channel.js` | 禁止 stdin；验证码 continuation、取消、过期、blocked、alreadyConnected 显式返回；新 Bot 不上传其他账号 token |
| 本地 logout | `auth/accounts.js`、`index.ts` | 只清 Piskie 微信根下的 account、context、sync、allowFrom、index；不存在 raw-ID / legacy 凭证 / legacy 游标分支，不触碰旧 OpenClaw 目录 |
| 存储根注入 | `storage/state-dir.js`、`../storage.ts`、`index.ts` | `resolveStateDir()` 返回宿主注入的 `<userData>/im-gateway/weixin`（未注入即抛错，无 `OPENCLAW_STATE_DIR`/`~/.openclaw` 回退）；新增 `resolveWeixinTempDir()` → `<tmpdir>/piskie-im/weixin`；`createWeixinConnector(storage)` 在每次创建 Connector（含扫码/退出临时实例）时绑定 |
| 目录层级 | `auth/accounts.js`、`storage/sync-buf.js`、`messaging/inbound.js`、`messaging/debug-mode.js` | 去掉 `openclaw-weixin/` 子层级：`accounts.json`、`accounts/*.json|*.sync.json|*.context-tokens.json`、`debug-mode.json` 直接位于微信根；`.d.ts` 只声明 `clearWeixinAccount`/`unregisterWeixinAccountId` |
| 旧数据分支移除 | `auth/accounts.js`、`storage/sync-buf.js` | 删除 `deriveRawAccountId`、legacy `credentials/openclaw-weixin/credentials.json`、legacy sync 游标、raw-ID 文件名回退与 `isUsingLegacyWeixinCredential`/`clearLegacyWeixinCredential`；`loadConfigRouteTag`/`loadConfigBotAgent` 固定返回 `undefined`（不再读 `OPENCLAW_CONFIG`/openclaw.json，api.js 用内置默认 botAgent） |
| 授权名单 | `auth/pairing.js` | allowFrom 与文件锁位于 `<weixinStateDir>/authorization/<accountId>-allowFrom.json`；不再读取 `OPENCLAW_OAUTH_DIR` 或 OpenClaw `credentials/` |
| 日志 | `util/logger.js`、`channel.js`、`core/vendor-log.ts` | 不再写 `openclaw-YYYY-MM-DD.log`、不读 `OPENCLAW_LOG_LEVEL`；经 `createVendorLogSink('openclaw-weixin')` 转发到 Piskie appLog（scope `messaging.vendor.openclaw-weixin`）；移除 `getLogFilePath()` |
| 出站临时目录 | `channel.js`、`messaging/process-message.js`、`core/openclaw-compat/infra-runtime.ts` | `resolvePreferredOpenClawTmpDir` 已删除；远程媒体下载到 `<weixinTempDir>/media/outbound-temp`（惰性解析），沿用原有 unlink 清理 |

## re-vendor 流程

1. `npm pack @tencent-weixin/openclaw-weixin@<version>`，校验包名、版本、LICENSE 和摘要。
2. 干净替换 `vendor/src` 为 tarball 的 `dist/src/**/*.js`，确认 JS 文件清单和数量。
3. 更新 `vendor/package.json` 与 LICENSE，删除 map/runtime 残余。
4. 重写 compat import，并恢复 no-op hook/config reload 边界。
5. 按上表逐项重放媒体、abort、重试、工具、QR、通知和 logout 适配。
6. 运行 vendor 完整性、类型检查、微信特征测试、四渠道回归、Electron 构建和真机长工具链验收。

账号、context token 和 sync buf 的**文件格式**沿用上游，但**存储位置**为 Piskie 专属根（`<userData>/im-gateway/weixin`），与独立 OpenClaw 的 `~/.openclaw` 隔离。项目处于开发阶段，不迁移、不读取旧目录：切换到隔离存储后既有用户需在 Piskie 内重新扫码一次；此后 re-vendor 升级不得再改变文件位置或格式，避免再次要求扫码。
