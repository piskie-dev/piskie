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

（除上表逻辑改动外，其余胶水在 runtime-adapter.ts / index.ts（TS 侧）。）

## re-vendor 流程

1. `npm pack @larksuite/openclaw-lark@<新版本>` 并解包
2. 跑 require 闭包脚本（doc 28 §3）重新收编 + 重放三类机械改动（说明符改写/import.meta 补丁/去 sourceMappingURL）
3. diff 闭包内新增的 `openclaw/plugin-sdk` require —— 新符号补进 `core/openclaw-compat/`
4. 回归：文本/图片收发、群聊 @、流式卡片、卡片交互（card.action.trigger）、配对、话题（thread）回复、断线重连
