// Production bootstrap - paths are already resolved by tsc-alias
// 在导入 main.js 之前把 cwd 固定到 userData：
// 避免相对路径落在只读安装目录或启动器的任意 cwd

import { app } from 'electron';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { registerAttachmentPreviewScheme } from './desktop/attachment-preview-protocol.js';

registerAttachmentPreviewScheme();

app.setPath('userData', path.join(os.homedir(), '.piskie'));

if (app.isPackaged) {
  const userDataPath = app.getPath('userData');
  fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  process.chdir(userDataPath);
  console.log('[Bootstrap] Working directory set to:', userDataPath);

}

// 每个 Electron 主进程只采集一次。失败会在主日志中记录并回退到原始 process.env。
const { initializeHostEnvironment } = await import('./environment/host-environment.js');
await initializeHostEnvironment();

// 动态导入 main.js，确保 cwd 已设置
await import('./main.js');
