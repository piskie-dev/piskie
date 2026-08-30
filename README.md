<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logos/piskie/app/piskie-brand-on-dark-256.png">
    <source media="(prefers-color-scheme: light)" srcset="logos/piskie/app/piskie-brand-on-light-256.png">
    <img src="logos/piskie/app/piskie-brand-on-light-256.png" alt="Piskie" width="96">
  </picture>

  <h1>Piskie</h1>

  <p><strong>A desktop AI agent for code, browsers, and repeatable operations.</strong></p>

  <p>
    <a href="https://piskie.dev">Website</a> ·
    <a href="#why-piskie">Why Piskie</a> ·
    <a href="#quick-start">Quick start</a>
  </p>

  <p>English | <a href="README.zh-CN.md">简体中文</a></p>
</div>

Piskie starts from the familiar coding-agent workflow of Codex and Claude Code: describe a goal, then let an agent inspect a project, edit files, run commands, plan work, and delegate tasks. It extends that workflow beyond code with managed fingerprint-browser environments, persistent account sessions, independent proxy routing for AI providers and browsers, reusable task definitions, built-in messaging channels, image generation, and a Browser Skill builder that turns verified website workflows into reusable tools.

> [!IMPORTANT]
> Piskie is in developer preview. Expect breaking changes to configuration, persisted data, and extension contracts.

## Why Piskie

Coding agents are optimized for repositories. Browser agents are often optimized for one-off web tasks. Piskie brings both into one local desktop workspace and makes browser identities and successful operating procedures reusable.

### Work like a coding agent

Use natural language to inspect and change projects, run shell commands, review results, and recover previous work. Piskie can plan larger tasks, delegate independent work to specialized agents, request approval before actions run, and keep plans, tool activity, browser sessions, artifacts, and history visible in one place.

### Operate a persistent browser account fleet

Piskie uses a managed, kernel-level fingerprint Chromium runtime for browser execution and exposes active sessions through an interactive view inside the desktop workspace.

Each browser environment keeps its own profile, cookies, login state, proxy route, identity policy, and human-readable purpose. Environments survive application restarts and can be bound as a pool to a reusable task, allowing an agent to select the right account without mixing sessions. Browser workers acquire environments exclusively while they are in use.

### Route AI providers and browsers independently

Maintain reusable HTTP, HTTPS, and SOCKS5 routes in one proxy pool, then assign a different proxy or direct connection to each configured AI or image provider and each browser environment. Model traffic and website-account traffic can use independent egress routes instead of sharing one application-wide proxy.

### Turn website workflows into Browser Skills

For a repeatable website workflow, Browser Skill mode can explore the live site, write a standard executable Skill, compile and hot-load it, call it against the real site, fix failures, verify it in an independent context, and publish it through the normal Skill installation path.

Later tasks discover and call the resulting business-level functions instead of repeating low-level page exploration. This can reduce repeated snapshots, tool round trips, and model context while shortening the execution path.

## Build once, reuse everywhere

```text
Explore a real workflow
        -> build SKILL.md + skill.ts
        -> compile and call the candidate
        -> verify every promised function and scenario
        -> publish
        -> reuse from Console, Task Definitions, or messaging
```

The first run teaches Piskie how a website workflow actually behaves. Future runs load the verified Skill, call its reusable functions, and fall back to low-level browser tools only for uncovered steps, recovery, or human boundaries such as login, CAPTCHA, payment, and final submission.

## Quick start

### Install Piskie

Download the desktop package for your platform, then install or launch Piskie as appropriate:

| Platform | Architecture | Package |
|---|---:|---|
| Windows | x64 | NSIS installer |
| macOS | arm64 / Apple Silicon | DMG or ZIP |
| Linux | x64 | DEB package |

On first launch, Piskie downloads, verifies, and installs its managed fingerprint Chromium runtime in the background. Keep a network connection available and allow sufficient disk space; you do not need to install system Chrome. Browser tasks become available after the managed runtime is ready.

The fingerprint-browser runtime supports the same host matrix. Intel macOS does not currently have a supported runtime.

### Run your first task

1. Open **Settings -> AI Providers**.
2. Add a provider, enter its endpoint and credential, enable a model, and test the connection.
3. Return to **Console**, choose a workspace and model, and keep the approval policy on **Confirm** for your first task.
4. Start with a bounded task in a disposable workspace, for example: `Inspect this repository and summarize its architecture without changing files.`
5. For browser work, create a **Browser Environment**, describe the account's purpose, configure its proxy or identity policy if needed, and bind it to a task.
6. To make a repeatable website tool, start a one-off task in **Browser Skill** mode and describe the capability and acceptance boundary you want to preserve.

## Reusable workflows and integrations

### Task Definitions

A Task Definition is a reusable launch recipe, not a previous run. It can preserve the task prompt, workspace, execution mode, approval policy, browser-environment pool, MCP capability boundary, and background behavior. Every launch creates a separate Agent Run with its own recoverable history, so updating a definition does not rewrite earlier results.

### Messaging agents

Bind a messaging-specific Task Definition to a bot and use the same workflow from the channels where work already arrives. Each direct-message or group conversation gets an independent Agent Run rather than sharing one mixed conversation.

Piskie includes channel implementations for:

- Feishu;
- WeCom;
- QQ Bot;
- Weixin personal accounts, including QR login.

These channels are built into the application and do not require a runtime plugin installation.

### Image generation and ComfyUI

The Image Gateway supports standard image-generation providers and native local ComfyUI workflow execution over its HTTP and WebSocket protocols. Agents can invoke image generation directly and keep the resulting artifacts with the conversation.

### Models and extensions

- Configure multiple named AI and image provider instances, including custom OpenAI- or Anthropic-compatible endpoints and local models.
- Choose provider-specific proxy routes and model-specific reasoning settings.
- Extend the workspace with Skills, executable plugins, and MCP servers.
- Reuse published Browser Skills through the same discovery, loading, and invocation path as other Skills.

## Example workloads

- Keep several accounts on the same website isolated, persistent, and available to the right task.
- Route different AI providers and browser environments through separate proxies while leaving others on a direct connection.
- Turn a recurring research, reporting, publishing, or back-office website process into a verified Browser Skill.
- Inspect, modify, test, and explain a local codebase with approval-aware file and shell tools.
- Bind a predefined support, research, or operations workflow to an IM bot without merging different conversations.
- Route visual tasks to a hosted image model or an existing local ComfyUI workflow.

## How Piskie works

```text
Desktop Console / IM
          |
Task Definition or one-off instruction
          |
 Director and Worker agents
          |
  +-------+----------------+----------------+
  |                        |                |
Files and shell  Fingerprint browsers   Image Gateway
  |                        |                |
  +------- Skills / MCP / Plugins ----------+
          |
History, artifacts, and reusable Browser Skills
```

The React Renderer communicates with Electron Main through a typed, sandboxed bridge. Agent, inference, configuration, MCP, plugin, Skill, and messaging runtimes live in Electron Main. Browser and local automation are implemented under `electron/piskiepilot/`; managed fingerprint Chromium remains a separate process controlled over CDP.

## Data and security

Piskie can execute shell commands, read and write local files, control browsers, install executable extensions, generate images through configured services, and send messages through configured IM channels. It is a powerful local application, not a security sandbox for agent actions.

- Use **Confirm** for unfamiliar tasks and review tool arguments before approving them.
- Install Skills and plugins, and connect MCP servers, only from sources you trust. They may run with the application's local permissions.
- The Electron Renderer uses `contextIsolation`, disables Node integration, enables the Chromium sandbox and `webSecurity`, and restricts navigation and new windows.
- Application data is stored under `~/.piskie`, including configuration, conversations, task state, browser profiles and cookies, IM sessions, installed extensions, generated artifacts, and logs.
- Provider, proxy, IM, MCP, and related credentials are currently stored in plaintext configuration. Unix file permissions are restricted, but this is not encryption and Windows does not provide equivalent POSIX mode semantics. Configuration tooling may return complete values.
- Use least-privilege or development credentials. Never publish `~/.piskie`; treat backups as sensitive and back up the directory before testing migrations or preview upgrades.

## Development

### Run from source

Source development requires:

- Node.js 24 (the major version is pinned in [`.nvmrc`](.nvmrc));
- npm 11.16.0 (declared by `packageManager`);
- Git.

Clone this repository, open its root directory, and run:

```bash
nvm use
npm ci
npm run dev
```

If `nvm` is not available on your platform, install Node.js 24 with your preferred version manager and continue with `npm ci`.

The Vite development server uses port `5174`; Electron remote debugging uses port `9223` in development.

### Build desktop packages

Run each packaging command on its native operating system:

| Platform | Command |
|---|---|
| Windows x64 | `npm run dist:win` |
| macOS arm64 | `npm run dist:mac` |
| Linux x64 | `npm run dist:linux` |

### Validate changes

Run the repository checks before opening a pull request:

```bash
npm run catalog:validate
npm run type-check
npx tsc -p tsconfig.electron.json --noEmit
npm run lint -- --quiet
npm run check:styles
npm test
npm run build
```

Live AI, image, browser, and MCP checks are opt-in because they require external services, local applications, or credentials. The default test suite does not require personal provider secrets.

Useful entry points:

| Path | Purpose |
|---|---|
| `src/` | React Renderer and UI state projections |
| `electron/agent/` | Agent runtime, roles, modules, specs, context, and prompts |
| `electron/browser-skill/` | Browser Skill candidate build, verification state, and publication |
| `electron/piskiepilot/` | In-process browser and local automation runtime |
| `electron/inference/` | AI and image configuration, drivers, and execution state |
| `electron/im-gateway/` | Built-in IM channels and message pipeline |
| `shared/` | Cross-process types, schemas, contracts, and model catalogs |

## Contributing and support

Piskie is not yet accepting compatibility-sensitive changes as a stable API. For bugs and focused proposals, use this repository's issue tracker and include the platform, reproduction steps, and sanitized logs. Do not include credentials, cookies, conversation content, or files from `~/.piskie`.

## License and trademarks

Piskie source code is licensed under the [MIT License](LICENSE). Vendored and adapted source remains subject to the licenses listed in [Third-Party Notices](THIRD_PARTY_NOTICES.md).

The Piskie name and logos are governed separately by the [Piskie Trademark Policy](TRADEMARKS.md). The MIT License does not grant permission to imply official status, affiliation, or endorsement.
