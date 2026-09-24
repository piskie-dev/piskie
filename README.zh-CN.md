<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logos/piskie/app/piskie-brand-on-dark-256.png">
    <source media="(prefers-color-scheme: light)" srcset="logos/piskie/app/piskie-brand-on-light-256.png">
    <img src="logos/piskie/app/piskie-brand-on-light-256.png" alt="Piskie" width="96">
  </picture>

  <h1>Piskie</h1>

  <p><strong>自带指纹浏览器与持久登录态的桌面级 AI Agent</strong></p>
  <p>不止于本地代码编写与命令行执行，更能在真实 Web 环境中自主操作、跨多账号协作，并将高频网站工作流自主沉淀为可复用的 Browser Skill。</p>

  <p>
    <a href="https://github.com/piskie-dev/piskie/releases"><img src="https://img.shields.io/github/v/release/piskie-dev/piskie?color=2563eb&label=Download" alt="Latest Release"></a>
    <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-emerald" alt="Platform Support">
    <a href="LICENSE"><img src="https://img.shields.io/github/license/piskie-dev/piskie" alt="License"></a>
    <a href="https://piskie.dev"><img src="https://img.shields.io/badge/Official-piskie.dev-indigo" alt="Official Site"></a>
  </p>

  <p>
    <a href="#-典型交互场景">场景演示</a> ·
    <a href="#-核心优势为什么选-piskie">核心特性</a> ·
    <a href="#-快速开始">快速安装</a> ·
    <a href="#配置与集成">配置与集成</a> ·
    <a href="README.md">English</a>
  </p>
</div>

---

## ⚡ 典型交互场景

Piskie 具备**本地环境操作**与**真实网页自主调度**双重闭环能力，无需人工反复登录或分步指引：

#### 场景 1：多账号、免重复登录的真实网页任务
> **解决痛点**：传统 Agent 每次打开新浏览器窗口都要用户重新扫码登录，极易触发网站防爬与风控。

```text
User: 登录我们的业务运营后台，统计最近 7 天各渠道的留存数据，并汇总到本地 reports/retention.csv
Piskie:
  ├── [环境调度] 挂载指纹环境「运营主账号」（自动复用 Session/Cookie，环境隔离免扫码）
  ├── [网页操作] 自主导航至数据分析看板，解析图表指标并导出明细数据
  └── [本地交付] 启动本地工作区，清洗数据并生成结构化 CSV 报表
```

#### 场景 2：将高频业务自主固化为「Browser Skill」
> **解决痛点**：每次操作网页都让大模型重新读 DOM 盲猜，速度慢、消耗海量 Token 且容易出错。

```text
User: 探索目标票务/预订网站，把指定日期的查询与筛选逻辑沉淀为一个标准工具
Piskie:
  ├── [自主探索] 启动受管 Chromium 探测目标页面的交互路径、输入表单与返回结构
  ├── [代码生成] 编写并本地验证自动化执行逻辑与参数 Schema
  └── [固化入库] 注册到本地 Skill 库。后续直接输入「查询明日早班排期」即可毫秒级调用
```

---

## 🌟 核心优势：为什么选 Piskie？

| 维度 | 传统 Web 自动化 / RPA | 普通 Web Agent | Piskie |
|---|---|---|---|
| **登录与账号隔离** | 需人工维护 Cookie 文本，极易失效 | 无独立环境，每次需人工扫码介入 | **原生多指纹环境隔离**，持久保留 Cookie 与登录态 |
| **工作流沉淀** | 依赖工程师手工编写与维护爬虫脚本 | 每次从零解析 DOM，Token 消耗极大 | **全自动生成 Browser Skill**，验证后固化为工具 |
| **本地开发与系统闭环**| 仅限浏览器端，无本地开发能力 | 需繁琐的 Docker/容器端口映射 | **桌面原生**：终端命令、文件读写、子 Agent 编排一站式打通 |
| **远程唤醒方式** | 只能在固定服务器或本地定时启动 | 必须打开前端网页使用 | **内置微信/企微/飞书/QQ 机器人**，随时随地手机远程调起 |

---

## 📦 核心能力概览

* **全自主代码与终端调度**：描述目标后，Agent 可自主制定计划、拆解子任务给从属 Agent、修改代码、执行测试并根据报错自我修正。
* **独立指纹浏览器环境**：每个环境拥有专属 Profile、Cookie、指纹参数与用途描述，完美应对多账号运营与防封需求。
* **从聊天软件直接发起任务**：原生内置企业微信、飞书、QQ 机器人以及微信个人号（扫码登录），不用坐在电脑前也能调起后台 Agent 干活。
* **定时与预设工作流（Task Definition）**：常用任务一键模板化，支持本地精准定时或周期性自动轮询执行。
* **多模态与本地生图**：支持主流 LLM/Claude 模型、内置网页搜索，并原生打通本地 ComfyUI 工作流。

---

## 🚀 快速开始

### 1. 下载安装

Piskie 提供各平台预编译桌面安装包，内置开箱即用的受管指纹 Chromium 运行时（无需用户自行安装配置 Chrome 或驱动）：

| 平台 | 架构 | 安装包 |
|---|---:|---|
| **Windows** | x64 | [前往 Releases 下载 .exe](https://github.com/piskie-dev/piskie/releases) |
| **macOS** | Apple Silicon (arm64) | [前往 Releases 下载 .dmg / .zip](https://github.com/piskie-dev/piskie/releases) |
| **Linux** | x64 | [前往 Releases 下载 .deb](https://github.com/piskie-dev/piskie/releases) |

> *注：首次启动应用时，Piskie 会在后台自动完成 Chromium 运行时的完整性校验。目前 Intel 架构 macOS 暂未支持受管浏览器运行时。*

### 2. 开始你的第一个任务

1. **配置模型**：打开 **设置中心 -> AI 配置**，填入你的 OpenAI / Claude 兼容接口密钥并测试连通。
2. **选择模式**：返回 **控制台**，选择工作目录与模型；新手建议保持 **需确认（Confirm）** 审批策略，实时掌控 Agent 的每一步工具调用。
3. **发起本地任务**：输入一句明确的需求，例如：
   ```text
   分析当前项目结构，梳理核心功能模块并输出 README 补充建议，不要修改已有文件。
   ```
4. **发起网页与指纹任务**：在控制台创建 **浏览器环境** 并设定账号用途，将环境与任务绑定后，输入网页任务需求即可。

---

## 🛠️ 配置与扩展

### 任务定义 (Task Definitions)
预设工作流保存了 Prompt、工作区、审批安全级别、浏览器环境绑定及 MCP 扩展。随时一键重跑，每次运行均保持上下文隔离。

### 定时调度与自动化
支持设置一次性或 Cron 周期任务（如“每日早 9 点爬取竞品更新并推送报告”）。应用运行期间自动调度，支持休眠后自动补跑。

### IM 远程联动
内置企业级沟通工具适配器（飞书、企业微信、QQ 机器人、个人微信），免插件配置，直接在对话框中唤醒 Piskie 并接收交付结果。

### 扩展生态与模型
* **插件标准**：全面兼容 MCP (Model Context Protocol) 协议、本地 Skill 与执行扩展插件。
* **独立网络代理**：AI 接口请求与不同指纹浏览器可分配独立不同的 HTTP/SOCKS5 代理线路，保护账号资产安全。
* **数据完全本地化**：所有对话历史、环境 Profile 及任务配置默认保存在 `~/.piskie`，不回传任何第三方服务器。

---

## 💻 源码编译与开发

如需二次开发或从源码构建：

```bash
# 需 Node.js 24 (见 .nvmrc) 与 npm 11.16+
git clone https://github.com/piskie-dev/piskie.git
cd piskie

nvm use
npm ci
npm run dev
```

构建本地桌面端安装程序：
```bash
npm run dist:win   # Windows x64
npm run dist:mac   # macOS arm64
```

---

## ⭐️ 支持与交流

如果你喜欢 Piskie，或者它在工作流中为你节省了时间，请在 GitHub 上为我们点亮一颗 **Star ⭐️**！这对于一个开源初期项目的成长至关重要。

* **问题反馈**：欢迎提交 [Issues](https://github.com/piskie-dev/piskie/issues)
* **官网与更新**：访问 [piskie.dev](https://piskie.dev)
