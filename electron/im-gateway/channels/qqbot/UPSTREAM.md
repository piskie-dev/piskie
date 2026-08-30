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
| `gateway.js` `otherMediaPaths` 并入 `MediaPaths`；`connect()` 在 token/gateway URL await 后、建 WebSocket 前复查 abort；settle 前 `msgQueue.waitForIdle(5s)` 有界等待在途处理 | 3 处 | 49号 §3.2.1/§11.1.54：停止后不建新连接；渠道自有队列纳入 Connector settle barrier |
| `api.js` token fetch 加 `AbortSignal.timeout(30s)` | 1 处 | 49号 §3.2.1：在途 I/O 必须有固定上限（getGatewayUrl 走 apiRequest 已有超时） |
| `message-queue.js` abort 后 `enqueue` 拒收新消息；drain/immediate 执行以 `activeWork` 集合追踪并暴露 `waitForIdle()` | 1 文件 | 49号 §3.2.1：fire-and-forget 队列处理纳入 settle barrier |
| `image-server.js` 新增导出 `downloadFileToBuffer()`（内存 Buffer 下载，复用 SSRF 防护/重试/超时，流式累积超限即断） | 1 处 | 49号 §4.3.1（审2阻断1）：供入站附件直落受管目录，不再经 vendor 自有下载目录中转 |
| `inbound-attachments.js` 非语音附件经 `ctx.saveMedia`（→ `ConnectorContext.media.saveBuffer`）直落受管目录（20MiB 上限）；语音仍留 vendor 目录（SILK→WAV+STT 本地消费，路径不移交核心） | 1 文件 | 49号 §4.3.1（审2阻断1）：渠道下载直接落 piskie-media；原始下载文件不在 vendor 目录永久保留 |
| `gateway.js` `saveMedia` 闭包接 `pluginRuntime.channel.media.saveInboundMediaBuffer`；4 个 pre-dispatch 早退（群未放行/drop_other_mention/未授权命令/未 @）调 `cleanupInboundLocalMedia()` | 5 处 | 49号 §4.3 条款2（审2阻断1/3）：dispatch 前失败由 Connector 清理本次落盘媒体 |
| `group-history.js` `formatAttachmentTags` 删 `MEDIA:${localPath}` 分支，全部改纯描述标签（`[图片: name]`/`[语音消息（内容: "…"）]` 等） | 1 处 | 49号 §4.3.5/§11.7（审2阻断2）：引用/历史/合并消息正文不含本地路径与占位符 |
| `ref-index-store.js` `formatMessageReferenceForAgent` try/finally：引用附件格式化完成后立即清理落盘文件（哨兵跳过） | 1 处 | 49号 §4.3.2（审2阻断2）：被引用消息附件不移交 dispatch，无 ownership handoff 不得泄漏 |
| `inbound-attachments.js` 新增导出 `buildInboundDynamicContext()`；`gateway.js` 动态上下文改用之——图片/语音不产生计数占位行，仅保留 ASR 参考转写行 | 2 处 | 49号 §11.3.14/§11.3.26（审3高5）：正文无媒体占位符；私聊纯图片保持空正文 `content: ''` + `ExternalEvent.images` |

## 行为说明

- `writeConfigFile` 在 PISKIE 宿主中为 no-op：qqbot 的"运行时回写配置"（凭证备份恢复、
  bot 昵称持久化）不适用于 bots.json 体系，跳过无害
- 语音链路（silk-wasm/mpg123-decoder 动态 import + 可用性探测）为回归重点

## re-vendor 流程

1. `npm pack @tencent-connect/openclaw-qqbot@<新版本>` 并解包
2. 跑 import 闭包脚本（doc 28 §3 同款，入口 dist/src/gateway.js）重新收编 + 重放上表机械改动
3. 新增 openclaw 引用 → 补 `core/openclaw-compat/`
4. 回归：群聊/频道收发、@ 提及、语音消息（silk 编解码）、图片（image-server）、断线重连、markdown 支持
