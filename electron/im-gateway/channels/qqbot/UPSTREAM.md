# QQ 机器人渠道 — 上游来源与本地改动

- **源包**：`@tencent-connect/openclaw-qqbot@1.7.1`（MIT，Tencent Connect 官方发布）
- **收编日期**：2026-07-07
- **收编来源**：npm tarball 的 `dist/src/*.js`（ESM 编译产物；上游同时发 TS 源码，为与其它渠道
  vendor 管线一致且规避 tsconfig 严格性差异，采用编译产物）
- **收编范围**：从 `dist/src/gateway.js` 起算的 **import 闭包 41 个文件**（含 channel.js——
  gateway/outbound-deliver 从中取 chunkText/stripMentionText 等函数，真实承重）
- **协议依赖**：`ws`（已有）、`silk-wasm`、`mpg123-decoder`（语音编解码，纯 WASM，
  留在 node_modules 由 Node 原生解析——silk.wasm 资产随包，无需搬运）

## 目录说明

- `vendor/` — 上游 ESM 产物近原样收编（仓库根 type:module，无 CJS 作用域问题）；**保持明文不混淆**
- `vendor/src/{gateway,runtime,config}.d.ts` — PISKIE 手写最小类型声明
- `runtime-adapter.ts` — `OpenClawRuntimeHost('qqbot')` 实例（共享实现见 core/openclaw-runtime-host.ts），
  经 vendor `runtime.js` 的 `setQQBotRuntime()` 注入；qqbot 消费面是 feishu 的子集
- `index.ts` — connector 胶水（替代上游 index.ts + channel.ts 的 startAccount 包装；
  凭证备份恢复逻辑裁剪——PISKIE 凭证每次启动来自 bots.json）

## vendor/ 内的本地改动（re-vendor 时机械重放）

| 改动 | 范围 | 说明 |
|---|---|---|
| `channel.js` 顶层 `import ... from "openclaw/plugin-sdk/core"` → `"../../../../core/openclaw-compat/core.js"` | 1 处 | 3 个 config-section 工具函数（仅 openclaw wizard 路径调用，PISKIE 不触发但 import 必须可解析），实现在 `core/openclaw-compat/core.ts` |
| 移除 `//# sourceMappingURL` 行 | 全部 | 未收编 .map |
| `gateway.js` 取消当前消息的 `[发送者 (ID)]` 文本前缀（单条 `senderPrefix` 与合并消息 `lastPart` 两处） | 2 处 | 49号 §4.2/§11.3.23：群消息发送者身份由核心 InboundPipeline 统一加一次 `[IM_GROUP_MEMBER ...]` 信封；合并/引用历史中较早消息的成员标签保留 |
| `inbound-attachments.js` 非图片附件与下载失败附件改为媒体条目上报（新增 `otherMediaPaths` 结果字段 + `download-failed://` 哨兵），不再拼 `[附件: 本地路径]`/失败提示进正文 | 1 文件 | 49号 §4.3.5/§4.3.8：本地路径不进正文；非图片/下载失败由核心层整条明确拒绝并固定回复。图片下载失败仍保留远程 URL 交核心层经受管目录下载 |
| `gateway.js` 媒体按原序经 `MediaUrls` 移交；`connect()` 在 token/gateway URL await 后、建 WebSocket 前复查 abort；settle 前 `msgQueue.waitForIdle(5s)` 有界等待在途处理 | 3 处 | Host 在原下标回填补下载结果；停止后不建新连接；渠道自有队列纳入 Connector settle barrier |
| `api.js` token fetch 加 `AbortSignal.timeout(30s)` | 1 处 | 49号 §3.2.1：在途 I/O 必须有固定上限（getGatewayUrl 走 apiRequest 已有超时） |
| `message-queue.js` abort 后 `enqueue` 拒收新消息；drain/immediate 执行以 `activeWork` 集合追踪并暴露 `waitForIdle()` | 1 文件 | 49号 §3.2.1：fire-and-forget 队列处理纳入 settle barrier |
| `image-server.js` 新增导出 `downloadFileToBuffer()`（内存 Buffer 下载，复用 SSRF 防护/重试/超时，流式累积超限即断） | 1 处 | 49号 §4.3.1（审2阻断1）：供入站附件直落受管目录，不再经 vendor 自有下载目录中转 |
| `inbound-attachments.js` 非语音附件经 `ctx.saveMedia`（→ `ConnectorContext.media.saveBuffer`）直落受管目录（单图 5 MiB，公共层合计 20 MiB）；语音仍留 vendor 目录（SILK→WAV+STT 本地消费，路径不移交核心） | 1 文件 | 渠道下载直接落 piskie-media；下载穿透账号取消信号；原始下载文件不在 vendor 目录永久保留 |
| `gateway.js` `saveMedia` 闭包接 `pluginRuntime.channel.media.saveInboundMediaBuffer`；4 个 pre-dispatch 早退（群未放行/drop_other_mention/未授权命令/未 @）调 `cleanupInboundLocalMedia()` | 5 处 | 49号 §4.3 条款2（审2阻断1/3）：dispatch 前失败由 Connector 清理本次落盘媒体 |
| `group-history.js` `formatAttachmentTags` 删 `MEDIA:${localPath}` 分支，全部改纯描述标签（`[图片: name]`/`[语音消息（内容: "…"）]` 等） | 1 处 | 49号 §4.3.5/§11.7（审2阻断2）：引用/历史/合并消息正文不含本地路径与占位符 |
| `ref-index-store.js` `formatMessageReferenceForAgent` try/finally：引用附件格式化完成后立即清理落盘文件（哨兵跳过） | 1 处 | 49号 §4.3.2（审2阻断2）：被引用消息附件不移交 dispatch，无 ownership handoff 不得泄漏 |
| `inbound-attachments.js` 新增导出 `buildInboundDynamicContext()`；`gateway.js` 动态上下文改用之——图片/语音不产生计数占位行，仅保留 ASR 参考转写行 | 2 处 | 49号 §11.3.14/§11.3.26（审3高5）：正文无媒体占位符；私聊纯图片保持空正文 `content: ''` + `ExternalEvent.images` |
| `gateway.js` 原 `deliver` 完整消费图片，`outbound-deliver.js` 移除延后到文字的工具媒体暂存/去重 | 2 文件 | 公共 `sendImageBatch` 按现有路径加载；纯图清理响应定时器，首轮之后继续发送；相同文件的不同工具输出分别投递，失败摘要等待同目标发送 |
| `api.js` `sendImageMessage` 与请求包装 | 1 文件 | 好友/群聊经 `file_data → file_info → msg_type:7`；频道及频道私信经 multipart `file_image`（含实际 MIME）；请求支持 FormData、账号取消和有限超时 |
| `gateway.js`、`reply-dispatcher.js`、`outbound-deliver.js` 频道私信目标 | 3 文件 | 既有事件保留 `guildId`；图片、普通文字和错误摘要使用 `/dms/{guildId}/messages`，入站会话以该 guild 为 peer；好友输入状态只用于 c2c |
| `utils/platform.js` 存储根改为宿主注入：新增 `configureQQBotStorage({dataDir, mediaDir})`、`resolveQQBotMediaDir()`；`getQQBotDataDir()` → `<userData>/im-gateway/qqbot/...`，`getQQBotMediaDir()` → `<userData>/im-gateway/qqbot/media/...`，未注入即抛错（不回退 `~/.openclaw`）；诊断提示删掉不存在的 `QQBOT_DATA_DIR` | 1 文件（+ 手写 `platform.d.ts`） | 存储隔离方案：`../storage.ts` 的 `bindQQBotStorage()` 在 `createQQBotConnector(storage)` 每次创建 Connector 时调用 |
| `session-store.js`、`known-users.js`、`ref-index-store.js`、`image-server.js`（默认下载目录）、`gateway.js`（图床目录）模块顶层路径常量改为惰性函数 | 5 文件 | 模块导入不再创建目录；`gateway.js` 图床固定 `getQQBotDataDir("images")`，删除 `QQBOT_IMAGE_SERVER_DIR` 覆盖 |
| `admin-resolver.js` 删除旧版 `admin-<accountId>.json` 回退/自动迁移；`startup-greeting.js` 删除全局 `startup-marker.json` 回退/自动迁移 | 2 文件 | Piskie 目录内没有旧文件，不迁移旧 OpenClaw 数据 |
| `gateway.js` 删除 `resolveSessionStorePath()`（读 `~/.openclaw/agents/*/sessions/sessions.json`）；`resolveGroupActivation()` 只按 `configRequireMention` 返回 `"mention"|"always"` | 1 文件 | 不读取外部 OpenClaw session store |
| `slash-commands.js`：`/bot-upgrade` 移除 OpenClaw 热更新分支（CLI 探测、凭据备份、配置改写、升级脚本下载/执行、gateway restart），改为返回"QQ 组件随 Piskie 更新"；`/bot-logs` 移除外部日志目录扫描/导出，改为提示使用 Piskie 应用日志导出；`/bot-clear-storage` 目标目录改为 `resolveQQBotMediaDir("downloads", appId)`；`getFrameworkVersion()` 改读 `getQQBotRuntime().version`（不再 exec `openclaw --version`）；删除 `child_process`/`createRequire`/`credential-backup`/`checkVersionExists` 等无用 import | 1 文件 | 三条旁路指令不再触碰外部 OpenClaw 安装、配置与日志；`credential-backup.js` 仅剩 `channel.js startAccount/isConfigured` 引用（Piskie 不调用），成为死代码但保留以减小 diff |

## 行为说明

- `writeConfigFile` 在 PISKIE 宿主中为 no-op：qqbot 的"运行时回写配置"（凭证备份恢复、
  bot 昵称持久化）不适用于 bots.json 体系，跳过无害
- 语音链路（silk-wasm/mpg123-decoder 动态 import + 可用性探测）为回归重点
- 存储：会话/已知用户/引用索引/admin/启动 marker/图床落 `<userData>/im-gateway/qqbot/{sessions,data,images}`，
  语音等 vendor 自留媒体落 `<userData>/im-gateway/qqbot/media`；入站图片/附件仍经 `ctx.saveMedia` 直落 Piskie
  受管媒体目录（`piskie-media`）。与同机独立 OpenClaw 的 `~/.openclaw/qqbot`、`~/.openclaw/media/qqbot` 互不读写，
  不迁移旧数据（首次启动重新建立会话/已知用户）

## re-vendor 流程

1. `npm pack @tencent-connect/openclaw-qqbot@<新版本>` 并解包
2. 跑 import 闭包脚本（doc 28 §3 同款，入口 dist/src/gateway.js）重新收编 + 重放上表机械改动
3. 新增 openclaw 引用 → 补 `core/openclaw-compat/`
4. 回归：群聊/频道收发、@ 提及、语音消息（silk 编解码）、图片（image-server）、断线重连、markdown 支持
5. 存储隔离回归：`channels/__tests__/storage-isolation.test.ts`、`qqbot/__tests__/slash-commands-local.test.ts`（模块导入零落盘、路径全部在注入根、旁路指令本地化）
