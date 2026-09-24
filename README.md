<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logos/piskie/app/piskie-brand-on-dark-256.png">
    <source media="(prefers-color-scheme: light)" srcset="logos/piskie/app/piskie-brand-on-light-256.png">
    <img src="logos/piskie/app/piskie-brand-on-light-256.png" alt="Piskie" width="96">
  </picture>

  <h1>Piskie</h1>

  <p><strong>The Desktop AI Agent with Fingerprint Browsers & Persistent Sessions.</strong></p>
  <p>Beyond local code editing and command execution: autonomously navigate the real web across multiple accounts, and solidify high-frequency web workflows into reusable Browser Skills.</p>

  <p>
    <a href="https://github.com/piskie-dev/piskie/releases"><img src="https://img.shields.io/github/v/release/piskie-dev/piskie?color=2563eb&label=Download" alt="Latest Release"></a>
    <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-emerald" alt="Platform Support">
    <a href="LICENSE"><img src="https://img.shields.io/github/license/piskie-dev/piskie" alt="License"></a>
    <a href="https://piskie.dev"><img src="https://img.shields.io/badge/Official-piskie.dev-indigo" alt="Official Site"></a>
  </p>

  <p>
    <a href="#-typical-scenarios">Interactive Scenarios</a> ·
    <a href="#-why-piskie">Why Piskie</a> ·
    <a href="#-quick-start">Quick Start</a> ·
    <a href="#configuration-and-integrations">Configuration</a> ·
    <a href="README.zh-CN.md">简体中文</a>
  </p>
</div>

---

## ⚡ Typical Scenarios

Piskie bridges **local workspace operations** and **real web automation** without tedious re-logins or step-by-step human steering:

#### Scenario 1: Multi-Account Web Tasks with Saved Login State
> **Pain Point**: Traditional agents spawn fresh browser sessions requiring users to re-scan QR codes or solve CAPTCHAs each time, quickly triggering anti-bot protections.

```text
User: Log into our operation dashboard, extract retention metrics across all channels for the past 7 days, and summarize into reports/retention.csv
Piskie:
  ├── [Environment] Mounts fingerprint environment "Primary Operator" (reuses session/cookies, isolated & zero re-logins)
  ├── [Web Actions] Autonomously navigates to analytics dashboard, extracts charts, and exports raw data
  └── [Local Delivery] Opens local workspace, cleans data, and formats into structured CSV
```

#### Scenario 2: Solidify Repetitive Web Workflows into Reusable "Browser Skills"
> **Pain Point**: Re-evaluating large DOM trees on every run is slow, burns enormous tokens, and is prone to drift.

```text
User: Explore the target booking portal, analyze the search and filter flow for specific dates, and turn it into a standard tool
Piskie:
  ├── [Autonomous Exploration] Launches managed Chromium to inspect page paths, forms, and API payloads
  ├── [Code Generation] Synthesizes and locally validates tool logic and input parameters
  └── [Installed as Skill] Registers into local Skill store. Future tasks can invoke "check schedule for tomorrow morning" directly in milliseconds
```

---

## 🌟 Why Piskie?

| Dimension | Traditional RPA / Scripts | Generic Web Agents | Piskie |
|---|---|---|---|
| **Sessions & Anti-Detect** | Manual cookie maintenance; brittle | Fresh sessions; repetitive QR logins | **Native fingerprint profiles**; persistent cookies & sessions |
| **Workflow Reuse** | Manual scraper script maintenance | Blindly re-parses DOM each time | **Autonomous Browser Skill synthesis**; verified & reusable |
| **Local System Loop** | Confined to browser; no local shell | Complex Docker / container port mapping | **Native desktop**: shell execution, file patching, sub-agent delegation |
| **Remote Triggers** | Scheduled on dedicated servers | Requires active desktop web UI | **Native IM Bots** (WeChat, Feishu, WeCom, QQ); trigger on the go |

---

## 📦 Key Capabilities

* **Full Local Execution Loop**: Outline goals in plain language. The agent inspects codebases, patches files, runs tests, and delegates independent tasks to sub-agents.
* **Fingerprint Browser Environments**: Profiles maintain cookies, canvas/WebGL fingerprints, and account purposes across app restarts.
* **Native IM Bot Integration**: Trigger tasks directly from Feishu, WeCom, QQ Bot, or personal Weixin accounts without leaving your chat window.
* **Task Definitions & Schedules**: Save reusable workflows; schedule one-off or recurring tasks while the desktop app is running.
* **Multi-Modal & Local Diffusion**: Supports leading LLMs, web search providers, and direct integration with local ComfyUI workflows over WebSockets.

---

## 🚀 Quick Start

### 1. Download & Install

Piskie provides pre-built desktop packages with an embedded fingerprint Chromium runtime:

| Platform | Architecture | Package |
|---|---:|---|
| **Windows** | x64 | [Download .exe from Releases](https://github.com/piskie-dev/piskie/releases) |
| **macOS** | Apple Silicon (arm64) | [Download .dmg / .zip from Releases](https://github.com/piskie-dev/piskie/releases) |
| **Linux** | x64 | [Download .deb from Releases](https://github.com/piskie-dev/piskie/releases) |

> *Note: On first launch, Piskie automatically verifies its managed Chromium runtime in the background. Intel-based macOS is not currently supported.*

### 2. Run Your First Task

1. **Configure Model**: Go to **Settings -> AI Providers**, enter your OpenAI or Claude-compatible credentials, and verify connectivity.
2. **Choose Mode**: Return to **Console**, select a workspace and model. Start with the **Confirm** approval policy to inspect tool calls step by step.
3. **Execute Local Task**: Give it a clear task, for example:
   ```text
   Inspect this repository, summarize key modules, and propose improvements without modifying files.
   ```
4. **Execute Web Task**: Create a **Browser Environment**, specify its account purpose, bind it to your task, and provide your web automation prompt.

---

## 🛠️ Configuration and Integrations

### Task Definitions
Save common prompts, workspaces, approval policies, browser environment pools, and MCP tools for one-click re-runs with isolated context.

### Scheduled Tasks
Configure one-off or recurring Cron tasks (e.g. daily metric crawls). Tasks execute while the app runs, with optional catch-up on wake-up.

### IM Channels
Built-in adapters for Feishu, WeCom, QQ Bot, and personal Weixin accounts. Start tasks and receive reports directly inside your chat apps.

### Extensions & Local Privacy
* **Protocols**: Fully compatible with MCP (Model Context Protocol), local Skills, and plugins.
* **Isolated Proxies**: Assign independent HTTP/SOCKS5 proxies to LLM requests and browser accounts.
* **Local Data**: App configuration, conversations, and browser profiles remain locally in `~/.piskie`.

---

## 💻 Development

To run from source or build packages locally:

```bash
# Requires Node.js 24 (see .nvmrc) and npm 11.16+
git clone https://github.com/piskie-dev/piskie.git
cd piskie

nvm use
npm ci
npm run dev
```

Build desktop packages:
```bash
npm run dist:win   # Windows x64
npm run dist:mac   # macOS arm64
```

---

## ⭐️ Support Us

If Piskie saves you time or inspires your automation workflows, please consider giving us a **Star ⭐️** on GitHub! Every star helps an early open-source project grow.

* **Feedback & Issues**: [Submit an Issue](https://github.com/piskie-dev/piskie/issues)
* **Website**: [piskie.dev](https://piskie.dev)
