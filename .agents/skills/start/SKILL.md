---
name: start
description: 用 Node 24 安全启动或重启 Piskie 开发环境，完成项目级进程清理、5174/9223 端口预检、编译、后台启动和启动校验。当用户要求启动、重启、运行本项目，或说“编译后启动 / 起一下 / 跑起来”时使用。
---

# 启动 Piskie 开发环境

始终从当前 Piskie Git 仓库根目录执行。项目使用 Node.js 24、Vite 端口 `5174`、Electron CDP 端口 `9223` 和 Electron userData `~/.piskie`。

## 安全边界

- 每条命令都显式使用仓库根目录和 Node 24 的 `PATH`，不依赖前一条命令的 shell 状态。
- 不执行通用的 `pkill -f electron`、`pkill -f vite` 或 `killall`。
- 只用本项目的 `npm run kill` 清理进程，并先执行 `npm run kill -- --dry-run`。
- 只有清理候选都属于当前仓库或 `~/.piskie` 时，才执行真实清理；发现其他项目进程就停止并报告。
- 清理后若 `5174` 或 `9223` 仍被占用，显示占用者并停止，不杀死无法确认归属的进程。

## 启动步骤

### 1. 准备 Node 24

```bash
piskie_root="$(git rev-parse --show-toplevel)"
cd "$piskie_root"
ls -d ~/.nvm/versions/node/v24.*/bin >/dev/null 2>&1 \
  || (export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 24)
export PATH="$(ls -d ~/.nvm/versions/node/v24.*/bin | sort -V | tail -1):$PATH"
node -v
```

确认输出为 `v24.x`，否则停止排查。

### 2. 预览并清理本项目进程

```bash
piskie_root="$(git rev-parse --show-toplevel)"
cd "$piskie_root"
export PATH="$(ls -d ~/.nvm/versions/node/v24.*/bin | sort -V | tail -1):$PATH"
npm run kill -- --dry-run
```

确认候选进程符合安全边界后，再单独执行：

```bash
piskie_root="$(git rev-parse --show-toplevel)"
cd "$piskie_root"
export PATH="$(ls -d ~/.nvm/versions/node/v24.*/bin | sort -V | tail -1):$PATH"
npm run kill
```

用 `ss -ltnp` 检查 `5174` 和 `9223`。仍有占用时显示进程并停止。

### 3. 校验 Electron 42

```bash
piskie_root="$(git rev-parse --show-toplevel)"
cd "$piskie_root"
export PATH="$(ls -d ~/.nvm/versions/node/v24.*/bin | sort -V | tail -1):$PATH"
cat node_modules/electron/dist/version 2>/dev/null \
  || ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

确认版本为 `42.x`。

### 4. 编译并后台启动

`npm run dev` 已包含 Vite、Electron 编译和启动。使用后台执行能力启动，保留任务句柄和日志路径：

```bash
piskie_root="$(git rev-parse --show-toplevel)"
cd "$piskie_root"
export PATH="$(ls -d ~/.nvm/versions/node/v24.*/bin | sort -V | tail -1):$PATH"
set -o pipefail
npm run dev 2>&1 | tee /tmp/piskie-dev.log
```

### 5. 验证启动结果

- 等待日志出现 `desktop.runtime.start.completed`；编译失败、进程退出或 `desktop.runtime.start.failed` 均视为失败。
- 运行 `npm run test:electron-host:live`，确认 `ok`、`runtimeReady`、`runtimeNotDegraded` 为 `true`，且 `degradedCount` 为 `0`。
- 确认 `5174/9223` 的监听进程属于当前仓库。
- `desktop.sandbox.fallback.enabled` 表示 sandbox 降级；可以继续，但最终报告必须说明。
- Linux 的 `vaInitialize/libva` 和 `GetVSyncParametersIfAvailable` GPU 告警可忽略。

停止或重启时重复进程预览与清理步骤，不使用全局进程清理命令。
