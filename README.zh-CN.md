<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logos/piskie/app/piskie-brand-on-dark-256.png">
    <source media="(prefers-color-scheme: light)" srcset="logos/piskie/app/piskie-brand-on-light-256.png">
    <img src="logos/piskie/app/piskie-brand-on-light-256.png" alt="Piskie" width="96">
  </picture>

  <h1>Piskie</h1>

  <p><strong>面向代码、浏览器与可复用业务操作的桌面 AI Agent。</strong></p>

  <p>
    <a href="https://piskie.dev">官方网站</a> ·
    <a href="#为什么选择-piskie">为什么选择 Piskie</a> ·
    <a href="#快速开始">快速开始</a>
  </p>

  <p><a href="README.md">English</a> | 简体中文</p>
</div>

Piskie 延续 Codex 和 Claude Code 这类编码 Agent 的直接工作方式：描述目标，让 Agent 检查项目、修改文件、运行命令、制定计划并委派任务。在此基础上，Piskie 将受管指纹浏览器环境、持久化账号会话、AI Provider 与浏览器独立代理路由、可复用任务定义、内置 IM 渠道、生图能力和 Browser Skill 构建器带入同一个桌面应用，将经过真实验证的网站流程转化为可复用工具。

> [!IMPORTANT]
> Piskie 目前处于开发者预览阶段，配置、持久化数据和扩展合同仍可能发生不兼容变更。

## 为什么选择 Piskie

编码 Agent 通常围绕代码仓库工作，浏览器 Agent 则往往面向一次性网页任务。Piskie 将两者放进同一个本地桌面工作区，并让浏览器身份和已经成功执行的操作流程都可以持续复用。

### 像编码 Agent 一样工作

使用自然语言检查和修改项目、执行 Shell 命令、审核结果并恢复历史工作。Piskie 可以为复杂任务制定计划，将独立工作委派给专门的 Agent，在执行动作前请求审批，并在同一个工作区中展示计划、工具活动、浏览器会话、产物和历史。

### 管理持久化多账号浏览器环境池

Piskie 的浏览器执行统一使用受管的内核级指纹 Chromium，并在桌面工作区内提供可交互的会话画面。

每个浏览器环境分别保存 Profile、Cookie、登录状态、代理路线、身份策略和用户填写的用途说明。环境数据在应用重启后继续保留，并可作为环境池绑定到可复用任务，让 Agent 按用途选择正确账号而不混淆会话。同一环境在使用期间只由一个浏览器 Worker 独占。

### 为 AI Provider 与浏览器环境独立配置代理

在统一代理池中维护可复用的 HTTP、HTTPS 和 SOCKS5 线路，并为每个已配置的 AI 或生图 Provider、每个浏览器环境分别选择不同代理或直连。模型请求与网站账号流量可以使用互不绑定的出口线路，而不必共享单一的应用级代理。

### 将网站流程转化为 Browser Skill

对于需要重复执行的网站流程，Browser Skill 模式可以探索真实网站、编写标准可执行 Skill、编译并热加载候选版本、在真实网站上调用、根据失败修复、在独立上下文中验证，最后通过统一的 Skill 安装链发布。

后续任务会发现并调用这些业务级函数，不再重复底层页面探索。这可以减少重复页面快照、工具往返和模型上下文开销，并缩短后续执行路径。

## 构建一次，处处复用

```text
探索真实流程
    -> 构建 SKILL.md + skill.ts
    -> 编译并调用候选版本
    -> 验证所有承诺的函数和场景
    -> 发布
    -> 从控制台、任务定义或 IM 中复用
```

第一次执行让 Piskie 理解网站流程的真实行为。后续执行会加载已经验证的 Skill 并调用可复用函数，只在尚未覆盖的步骤、失败恢复或登录、验证码、支付、最终提交等人工边界处回到基础浏览器工具。

## 快速开始

### 安装 Piskie

下载对应平台的桌面安装包，并按该平台的方式安装或启动 Piskie：

| 平台 | 架构 | 安装包 |
|---|---:|---|
| Windows | x64 | NSIS 安装器 |
| macOS | arm64 / Apple Silicon | DMG 或 ZIP |
| Linux | x64 | DEB 安装包 |

首次启动时，Piskie 会在后台下载、校验并安装受管指纹 Chromium。请保持网络连接并预留足够磁盘空间；无需预先安装系统 Chrome。受管运行时就绪后，浏览器任务即可使用。

指纹浏览器运行时支持同一组宿主平台。Intel macOS 当前没有受支持的运行时。

### 完成第一个任务

1. 打开 **设置中心 -> AI 配置**。
2. 添加 Provider，填写接口地址和凭据，启用一个模型，然后测试连接。
3. 回到 **控制台**，选择工作区和模型；第一次执行时保持 **需确认（Confirm）** 审批策略。
4. 先在可丢弃的工作区中执行边界明确的任务，例如：`检查这个仓库并总结架构，不要修改文件。`
5. 如需执行浏览器任务，创建一个 **浏览器环境**，说明账号用途，按需配置代理或身份策略，并将它绑定到任务。
6. 如需制作可复用的网站工具，以 **Browser Skill** 模式启动一次性任务，并描述要固化的能力及验收边界。

## 可复用工作流与集成

### Task Definition（预设 AI 工作流）

Task Definition 是可复用的启动配方，不是某次历史运行。它可以保存任务提示、工作区、执行模式、审批策略、浏览器环境池、MCP 能力边界和后台行为。每次启动都会创建一条具有独立可恢复历史的 Agent Run，因此修改任务定义不会改写之前的运行结果。

### IM Agent

将面向消息渠道的 Task Definition 绑定到 Bot，即可从日常接收工作的渠道中启动同一套流程。每个私聊或群聊会话都会获得独立的 Agent Run，不会混入同一段共享对话。

Piskie 内置以下渠道实现：

- 飞书；
- 企业微信；
- QQ Bot；
- 微信个人号，包括扫码登录。

这些渠道随应用内置，不需要在运行时另行安装插件。

### 生图与 ComfyUI

Image Gateway 同时支持标准图片生成 Provider，以及通过原生 HTTP 和 WebSocket 协议执行本地 ComfyUI 工作流。Agent 可以直接调用生图能力，并将结果产物保存在对应会话中。

### 模型与扩展

- 配置多个具名 AI 与图片 Provider 实例，包括自定义 OpenAI/Anthropic 兼容端点和本地模型。
- 为不同 Provider 选择独立代理线路，并为不同模型选择对应的思考设置。
- 通过 Skill、可执行插件和 MCP Server 扩展工作区。
- 已发布的 Browser Skill 与其他 Skill 共用发现、加载和调用链路。

## 典型任务

- 让同一网站上的多个账号保持隔离和登录状态，并把正确账号交给对应任务。
- 让不同 AI Provider 和浏览器环境分别使用不同代理，同时允许其他连接保持直连。
- 将重复的调研、报告、发布或后台业务流程转化为经过验证的 Browser Skill。
- 使用带审批的文件和 Shell 工具检查、修改、测试并解释本地代码库。
- 将预设的客服、调研或运营工作流绑定到 IM Bot，同时保持不同会话相互独立。
- 将视觉任务路由到托管图片模型或已有的本地 ComfyUI 工作流。

## Piskie 如何工作

```text
桌面控制台 / IM
       |
任务定义或一次性指令
       |
 Director 与 Worker
       |
  +----+------------+-------------+
  |                 |             |
文件与 Shell    指纹浏览器     Image Gateway
  |                 |             |
  +---- Skill / MCP / Plugin -----+
       |
历史、产物与可复用 Browser Skill
```

React Renderer 通过类型化且受沙箱保护的桥接层与 Electron Main 通信。Agent、推理、配置、MCP、插件、Skill 和 IM Runtime 位于 Electron Main。浏览器与本地自动化实现在 `electron/piskiepilot/` 中；受管指纹 Chromium 保持为通过 CDP 控制的独立进程。

## 数据与安全

Piskie 可以执行 Shell 命令、读写本地文件、控制浏览器、安装可执行扩展、通过已配置服务生成图片，并通过已配置的 IM 渠道发送消息。它是一个具有真实本地权限的应用，不是隔离 Agent 行为的安全沙箱。

- 对不熟悉的任务使用 **需确认（Confirm）**，批准前检查工具参数。
- 只从可信来源安装 Skill 和插件、连接 MCP Server；它们可能以应用的本地权限运行。
- Electron Renderer 开启 `contextIsolation`、关闭 Node 集成、开启 Chromium sandbox 与 `webSecurity`，并限制导航和新窗口。
- 应用数据保存在 `~/.piskie`，包括配置、对话、任务状态、浏览器 Profile 与 Cookie、IM 会话、已安装扩展、生成产物和日志。
- Provider、代理、IM、MCP 及相关凭据目前以明文配置保存。Unix 文件权限会被收紧，但这不等于加密，Windows 也不具备等价的 POSIX mode 语义；配置工具可能返回完整值。
- 使用最小权限或开发专用凭据。不要公开 `~/.piskie`；备份同样属于敏感数据，在测试迁移或预览版升级前先备份该目录。

## 开发与验证

### 从源码运行

源码开发需要：

- Node.js 24（主版本固定在 [`.nvmrc`](.nvmrc)）；
- npm 11.16.0（由 `packageManager` 声明）；
- Git。

克隆本仓库后，在仓库根目录运行：

```bash
nvm use
npm ci
npm run dev
```

如果当前平台没有 `nvm`，请使用你习惯的版本管理器安装 Node.js 24，然后从 `npm ci` 继续。

Vite 开发服务器使用端口 `5174`；开发环境中的 Electron 远程调试使用端口 `9223`。

### 构建桌面安装包

每条打包命令应在对应的原生操作系统上执行：

| 平台 | 命令 |
|---|---|
| Windows x64 | `npm run dist:win` |
| macOS arm64 | `npm run dist:mac` |
| Linux x64 | `npm run dist:linux` |

### 验证改动

提交 Pull Request 前运行仓库验证：

```bash
npm run catalog:validate
npm run type-check
npx tsc -p tsconfig.electron.json --noEmit
npm run lint -- --quiet
npm run check:styles
npm test
npm run build
```

真实 AI、图片、浏览器和 MCP 验证需要外部服务、本地应用或凭据，因此默认不运行。默认测试集不依赖个人 Provider 密钥。

主要代码入口：

| 路径 | 职责 |
|---|---|
| `src/` | React Renderer 与 UI 状态投影 |
| `electron/agent/` | Agent Runtime、角色、模块、Spec、上下文和提示词 |
| `electron/browser-skill/` | Browser Skill 候选构建、验证状态与发布 |
| `electron/piskiepilot/` | 进程内浏览器与本地自动化 Runtime |
| `electron/inference/` | AI/图片配置、Driver 与执行状态 |
| `electron/im-gateway/` | 内置 IM 渠道和消息管线 |
| `shared/` | 跨进程类型、Schema、合同和模型目录 |

## 参与贡献与反馈

Piskie 尚未将兼容性敏感接口承诺为稳定 API。提交 Bug 或范围明确的建议时，请使用本仓库的 Issue Tracker，并附上平台、复现步骤和完成脱敏的日志。不要提交凭据、Cookie、对话内容或 `~/.piskie` 中的文件。

## 许可证与商标

Piskie 源码采用 [MIT License](LICENSE)。随仓库分发的第三方 vendor 与派生源码继续适用 [Third-Party Notices](THIRD_PARTY_NOTICES.md) 中列出的许可证和归属声明。

Piskie 名称和 Logo 单独受 [Piskie 商标政策](TRADEMARKS.md)约束。MIT 许可证不授予暗示官方身份、关联或认可的权利。
