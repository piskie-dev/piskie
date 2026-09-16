# 飞书渠道 — 上游来源与本地改动

- **源包**：`@larksuite/openclaw-lark@2026.3.26`（MIT，ByteDance/Larksuite 官方发布）
- **收编日期**：2026-07-07
- **收编来源**：npm tarball 的编译产物（**CJS**，上游不随包发布 TS 源码）
- **收编范围**：从 `src/channel/monitor.js` 起算的 **require 闭包 103 个文件**（全包 173 个 js；
  闭包外的 tools 工具族/plugin.js/onboarding/probe/directory 等未收编——它们经 openclaw
  registerTool/setup 机制注册，在 PISKIE 中本为死代码）。闭包计算脚本见 doc 28 §3
- **协议 SDK**：`@larksuiteoapi/node-sdk`、`@sinclair/typebox`（主 package.json 依赖，未 vendor）

## 目录说明

- `vendor/` — 上游 CJS 产物近原样收编；`vendor/package.json` 声明 `"type": "commonjs"`
  （仓库根是 ESM 作用域，必须显式覆盖）；**保持明文不混淆**
- `vendor/openclaw-compat/` — 8 个 CJS 桥接文件，`module.exports = require('../../../../core/openclaw-compat/<mod>.js')`
  （Node 24 require(esm)），是 vendor 内改写后 require 的解析目标
- `vendor/src/channel/monitor.d.ts`、`vendor/src/core/lark-client.d.ts` — PISKIE 手写的最小类型声明
- `runtime-adapter.ts` — **FeishuRuntimeHost**：lark 经 `LarkClient.setRuntime()` 静态缝消费的
  openclaw runtime 本地宿主（旧全局 ChannelRuntimeAdapter 机制的渠道内收编版，桥接框架
  InboundPipeline）。openclaw 接口形状由此收敛进 feishu 渠道边界
- `index.ts` — connector 胶水（替代上游 index.js + channel/plugin.js）

## vendor/ 内的本地改动（re-vendor 时机械重放，均有脚本）

| 改动 | 范围 | 说明 |
|---|---|---|
| `require("openclaw/plugin-sdk/<mod>")` → 相对路径指向 `vendor/openclaw-compat/<mod>.js` | 13 处 / 10 文件 | 8 个模块：account-id、allow-from、channel-feedback、channel-runtime、reply-history、reply-runtime、routing、zalouser（12 个符号，实现见 `core/openclaw-compat/`） |
| `import.meta.url` → `require("node:url").pathToFileURL(__filename).href` | 1 处（core/version.js） | CJS 产物残留 ESM 语法，与旧 plugin-installer.patchImportMetaInCjs 同款补丁 |
| 移除 `//# sourceMappingURL` 行 | 全部 | 未收编 .map |
| `messaging/inbound/media-resolver.js` 下载失败推 `download-failed://` 哨兵条目；`buildFeishuMediaPayload` 不再把本地路径填进 `MediaUrl(s)` | 2 处 | 49号 §4.3.1/§4.3.8：MediaUrl(s) 语义是待下载远程 URL；下载失败由核心层整条明确失败，不静默丢弃 |
| `messaging/inbound/enrich.js` `substituteMediaPaths` 改为剥除媒体占位符（不再把本地路径替换进正文）；`dispatch-builders.js` 注释同步 | 2 文件 | 49号 §4.3.5/§11.7：正文不含本地路径/占位符；图片经 MediaPaths 走 `ExternalEvent.images` |
| `core/lark-client.js` `startWS` 的 probe 等待有界（15s 上限 + abort 可中断）并在 probe 后复查 abort | 1 处 | 49号 §3.2.1 abort 契约：启动 await 前后检查 signal、在途等待有固定上限 |
| `card/reply-dispatcher.js` 在文字分支前消费完整 `mediaUrls` | 1 文件 | 公共 `sendImageBatch` 有界读取当前文件；`uploadImageLark(Buffer)` + `sendImageLark` 发送原生图片，保留账号/聊天/线程；卡片完成后继续使用原回调发送图片和文字，等待同目标错误通知 |
| `messaging/outbound/media.js` 原生图片请求与下载流 | 1 文件 | 上传和发送请求传入取消信号与 120 秒超时；消息响应校验；入站下载限制实际字节数，不扩大本地目录授权 |
| `messaging/inbound/{handler,enrich,dispatch,media-resolver}.js` | 4 文件 | 传递账号停止信号；单图 5 MiB、10 张/合计 20 MiB，保持资源顺序和下载失败哨兵 |
| 新增 `core/token-store-location.js`（+ 手写 `.d.ts`）：`configureFeishuTokenStore({credentialsDir, keychainService})` / `requireFeishuTokenStoreLocation()`，状态挂 `globalThis[Symbol.for(...)]` | 新文件 | 存储隔离方案：宿主 `../storage.ts` 的 `bindFeishuStorage()` 在 `createFeishuConnector(storage)` 每次创建 Connector 时注入 `<userData>/im-gateway/feishu/credentials` 与 service `piskie-feishu-uat`；用 globalThis 是因为该 CJS 模块会被宿主 ESM import 与 vendor require 两路加载（vitest 下为两个实例） |
| `core/token-store.js`：`KEYCHAIN_SERVICE`、`LINUX_UAT_DIR`/`MASTER_KEY_PATH`、`WIN32_UAT_DIR`/`WIN32_MASTER_KEY_PATH` 模块级常量改为每次操作时从 token-store-location 读取；删除 `node:os` require | 1 文件 | macOS Keychain service 改为 `piskie-feishu-uat`；Linux/Windows 加密文件目录改为注入的 credentialsDir（不再按 `XDG_DATA_HOME`/`%LOCALAPPDATA%` 推导 `openclaw-feishu-uat`）；账号 key、AES-256-GCM、0600 权限处理原样；未注入即抛错；不读取/迁移/删除旧位置，用户需重新授权。macOS Keychain 分支未在本机（Linux）实测 |

`index.ts` 将账号停止信号传给上述回调，回复出口保留原 dispatcher。CJS vendor 通过 Node 24 `require(esm)` 调用公共 `core/media-io.js`；构建保持同构目录，测试使用 `feishu-cjs-source-resolver.setup.ts` 加载对应 TS 源码。

## re-vendor 流程

1. `npm pack @larksuite/openclaw-lark@<新版本>` 并解包
2. 跑 require 闭包脚本（doc 28 §3）重新收编 + 重放三类机械改动（说明符改写/import.meta 补丁/去 sourceMappingURL）
3. diff 闭包内新增的 `openclaw/plugin-sdk` require —— 新符号补进 `core/openclaw-compat/`
4. 回归：文本/图片收发、群聊 @、流式卡片、卡片交互（card.action.trigger）、配对、话题（thread）回复、断线重连
5. 存储隔离回归：`channels/__tests__/storage-isolation.test.ts`（Linux 加密文件后端落 `im-gateway/feishu/credentials`，XDG 旧目录不被读写）；`commands/diagnose.js` 读取 `~/.openclaw/logs/gateway.log` 的分支仅经 `registerCommands` 可达，Piskie 从未调用，保持原样
