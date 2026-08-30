# 企业微信渠道 — 上游来源与本地改动

- **源包**：`@wecom/wecom-openclaw-plugin@2026.4.2`（MIT，Tencent WeCom 官方发布）
- **上游仓库**：`https://github.com/WecomTeam/wecom-openclaw-plugin`
- **上游提交**：`b577d9893b0a10227cf5501b6212737548b3c025`
- **npm integrity**：`sha512-kwRO1RuZIXcKhw/m1YYK/FFnjiC0k9MHLgyImnp1InXKnxYRcV1fd+R/2wez+2K7r/g6brDIzPXSCYm9Oh8m8A==`
- **收编日期**：2026-07-07
- **收编来源**：npm tarball 的 `dist/esm/src/*.js`（上游不随包发布 TS 源码）+ `dist/esm/types/src/*.d.ts`
- **许可证**：`vendor/LICENSE`
- **协议 SDK**：`@wecom/aibot-node-sdk`（主 package.json 依赖，未 vendor）

## 目录说明

- `vendor/` — 上游编译产物近原样收编（ESM JS + 配套 d.ts），**保持明文不混淆**
- `account.ts` / `index.ts` — PISKIE 胶水（新写，替代上游 index.js + channel.js + runtime.js + utils.js）

## 未收编（裁剪）的上游文件及原因

| 上游文件 | 原因 |
|---|---|
| `index.js`、`channel.js`、`runtime.js` | openclaw 插件注册胶水（register/setupWizard/status/config 账户管理/outbound），由 `index.ts` + PISKIE 框架承担；其中 `sendWeComMessage`/outbound 命名空间在 PISKIE 链路本就是死代码 |
| `onboarding.js` | openclaw CLI setup wizard，PISKIE 用 Connections UI 配置 |
| `mcp/`（tool/transport/schema/interceptors，~1000 行） | 经 `api.registerTool` 注册，PISKIE 的 createPluginApi 对其恒为 no-op stub，收编前即死代码 |
| `utils.js` | `resolveWeComAccount(OpenClawConfig)` 改写为 `account.ts`（直读 IMBotConfig）；`setWeComAccount` 仅 wizard 使用 |

## vendor/ 内的本地改动（re-vendor 时需重放）

| 文件 | 改动 |
|---|---|
| `media-compat.js`（原名 openclaw-compat.js） | 删除 openclaw SDK 动态探测，固定走文件自带 fallback；导出 `fetchRemoteMedia` |
| `monitor.js` | ① `buildMessageContext`（组装 openclaw InboundContext + resolveAgentRoute）改写为 `buildInboundMessage`（框架 InboundMessage）；② `routeAndDispatchMessage` 由 `core.channel.reply.dispatchReplyWithBufferedBlockDispatcher` 改为框架 `dispatch(msg, callbacks)`（onReplyStart/deliver/onError 语义不变）；③ `monitorWeComProvider`/`processWeComMessage` 参数去 config，增 media/pairing/dispatch |
| `dm-policy.js` | `core.channel.pairing.{readAllowFromStore,upsertPairingRequest,buildPairingReply}` → 框架 `pairing.{getAllowedSenders,request,buildReply}` |
| `group-policy.js` | 配置读取由 `config.channels.wecom` 改为 `account.config`（两者原本即同一对象） |
| `media-handler.js` | `core.channel.media.{saveMediaBuffer,fetchRemoteMedia}` → 框架 `media.saveBuffer` + media-compat `fetchRemoteMedia`（顺带修复原 fallback 期望 buffer 而 PISKIE 旧 adapter 返回 path 的隐性 bug）；下载失败改推 `download-failed://` 哨兵条目（49号 §4.3.8：整条明确失败，不静默丢弃伪装成无附件文本） |
| `media-uploader.js` | import `./openclaw-compat.js` → `./media-compat.js` |
| 各配套 `.d.ts` | 同步以上签名变化；openclaw 类型引用替换为 `compat-types.d.ts` 本地替身 |
| 全部 `.js` | 移除 `//# sourceMappingURL` 行（未收编 .map） |

## re-vendor 流程

1. `npm pack @wecom/wecom-openclaw-plugin@<新版本>` 并解包
2. diff 新旧 `dist/esm/src/`，将协议核心变更（monitor 的 WS 事件处理、message-sender、media-*、template-card-parser、state-manager 等）合入 `vendor/`
3. 按上表重放本地改动（胶水触点集中，逐条对照即可）
4. 回归：收发文本/图片/文件、群聊策略、配对、模板卡片、流式过期降级
