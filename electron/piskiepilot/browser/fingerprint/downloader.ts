/**
 * 内核二进制(fingerprint-chromium)下载器 —— GitHub Releases 分发。
 *
 * 版本用代码钉 tag(FPC_RELEASE),与 seed.ts 的 seed 合法性判据版本锁死。
 * 流程:缓存未命中 → 下载 release asset(Range 续传 + 重试)→ sha256 强校验
 *      → 跨平台解压(mac ditto / win tar / linux tar -xJf)→ 原子就位 → 平台后处理。
 * 并发去重:同 host 同时触发只下载一次,其余 await 同一 Promise。
 * 进度经 downloadEvents 事件源上抛，由 PilotApplication 转发渲染端。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { getFingerprintBinDir } from '@electron/piskiepilot/paths.js';
import { HOST_KEY, HOST_EXE, cacheExecPath, cacheHostDir } from './host.js';

export interface FpcAsset {
  file: string;
  /** 归档 sha256(release 发布后填入;为空时 doInstall 报错拒绝下载,防止装未校验产物) */
  sha256: string;
  archive: 'zip' | 'tar.xz';
}
export interface FpcRelease {
  repo: string;
  tag: string;
  assets: Record<string, FpcAsset>;
}

/**
 * 单一事实源:与 seed.ts 的 LEGAL_SEED_LAW_VERSION 锁在一起。
 * 升级 fpc 版本时:发新 release → 改此处 tag/sha256 →
 * **复跑 `node scripts/fp-seed-sweep.mjs` 确认 seed 合法性判据(mod-3)仍成立** →
 * 更新 seed.ts 的 LEGAL_SEED_LAW_VERSION。判据失效会让 deviceMemory 静默变成不合规值。
 * sha256 为空 = 该平台 release 尚未发布/未回填,下载会报错(见 doInstall)。
 */
export const FPC_RELEASE: FpcRelease = {
  repo: 'qwy-dmb/fingerprint-chromium-dist',
  tag: 'fpc-148.0.7778.215',
  assets: {
    'darwin-arm64': {
      file: 'fpc-148.0.7778.215-darwin-arm64.zip',
      sha256: '90c8af40dd3e2cfbc34aa4e68172d919b5a347ed7cf35be9313e7b4ff5911a7f',
      archive: 'zip',
    },
    'win32-x64': {
      file: 'fpc-148.0.7778.215-win32-x64.zip',
      sha256: 'b4d91ba966622c92d094336afba8a3031bf7ea372c04904508b650d58df6fb4d',
      archive: 'zip',
    },
    'linux-x64': {
      file: 'fpc-148.0.7778.215-linux-x64.tar.xz',
      sha256: 'f24f8f270a0faf28f02e414690e127227a9e6144a026d75c962b5488c4df4478',
      archive: 'tar.xz',
    },
  },
};

function assetUrl(a: FpcAsset): string {
  return `https://github.com/${FPC_RELEASE.repo}/releases/download/${FPC_RELEASE.tag}/${a.file}`;
}

export type DownloadPhase = 'download' | 'verify' | 'extract' | 'done' | 'error';
export interface DownloadProgress {
  hostKey: string;
  phase: DownloadPhase;
  received?: number;
  total?: number;
  message?: string;
}

/** 下载进度事件源（'progress' → DownloadProgress），由 PilotApplication 订阅并转发渲染端。 */
export const downloadEvents = new EventEmitter();
const latestProgress = new Map<string, DownloadProgress>();

function emit(p: DownloadProgress): void {
  const next = { ...latestProgress.get(p.hostKey), ...p };
  latestProgress.set(p.hostKey, next);
  downloadEvents.emit('progress', { ...next });
}

/** 供晚于自动下载启动的渲染进程恢复当前进度。 */
export function getDownloadProgress(hostKey: string = HOST_KEY): DownloadProgress | undefined {
  const progress = latestProgress.get(hostKey);
  return progress ? { ...progress } : undefined;
}

/** 内核二进制是否已就位(缓存命中) */
export function isInstalled(hostKey: string = HOST_KEY): boolean {
  const envPath = process.env.FP_CHROMIUM_PATH;
  if (envPath) return existsSync(envPath);
  const exe = cacheExecPath(hostKey);
  return !!exe && existsSync(exe);
}

/** 本 host 是否有对应且已配置校验值的 release asset */
export function hasAssetForHost(hostKey: string = HOST_KEY): boolean {
  const asset = FPC_RELEASE.assets[hostKey];
  return !!asset && /^[a-f\d]{64}$/i.test(asset.sha256);
}

const inflight = new Map<string, Promise<string>>();

/** 确保内核二进制就位,返回可执行路径。缓存命中直接返回;否则下载+校验+解压。并发去重。 */
export function ensureBinary(hostKey: string = HOST_KEY): Promise<string> {
  const envPath = process.env.FP_CHROMIUM_PATH;
  if (envPath) {
    if (existsSync(envPath)) return Promise.resolve(envPath);
    const error = new Error(`FP_CHROMIUM_PATH 指向的文件不存在: ${envPath}`);
    emit({ hostKey, phase: 'error', message: error.message });
    return Promise.reject(error);
  }
  const exe = cacheExecPath(hostKey);
  if (exe && existsSync(exe)) return Promise.resolve(exe);
  const running = inflight.get(hostKey);
  if (running) return running;
  const p = doInstall(hostKey).finally(() => inflight.delete(hostKey));
  inflight.set(hostKey, p);
  return p;
}

async function doInstall(hostKey: string): Promise<string> {
  let staging: string | undefined;

  try {
    const asset = FPC_RELEASE.assets[hostKey];
    if (!asset) {
      throw new Error(`无 fingerprint-chromium release asset 对应 host ${hostKey}(不支持自动下载)`);
    }
    if (!asset.sha256) {
      throw new Error(
        `FPC_RELEASE 中 ${hostKey} 的 sha256 未配置(release ${FPC_RELEASE.tag} 发布后回填);当前无法自动下载。`,
      );
    }

    const exeRel = HOST_EXE[hostKey];
    const binDir = getFingerprintBinDir();
    const tmpDir = join(binDir, '.tmp');
    mkdirSync(tmpDir, { recursive: true });
    const archivePath = join(tmpDir, asset.file);
    staging = join(tmpDir, `staging-${hostKey}`);
    const finalDir = cacheHostDir(hostKey);

    // 1. 下载(Range 续传 + 重试)
    emit({
      hostKey,
      phase: 'download',
      received: existsSync(archivePath) ? statSync(archivePath).size : 0,
      total: undefined,
      message: undefined,
    });
    await downloadWithResume(assetUrl(asset), archivePath, hostKey);

    // 2. sha256 强校验
    emit({ hostKey, phase: 'verify' });
    const actual = await sha256File(archivePath);
    if (actual.toLowerCase() !== asset.sha256.toLowerCase()) {
      rmSync(archivePath, { force: true });
      throw new Error(`sha256 不匹配(期望 ${asset.sha256.slice(0, 12)}… 实得 ${actual.slice(0, 12)}…),已删除下载文件`);
    }

    // 3. 解压到 staging
    emit({ hostKey, phase: 'extract' });
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    extractArchive(archivePath, staging, asset.archive);

    // 4. 校验 exe 存在(归档结构须与 HOST_EXE 一致)
    const stagedExe = join(staging, exeRel);
    if (!existsSync(stagedExe)) {
      throw new Error(`解压后未找到可执行文件 ${exeRel}(归档内部结构与 HOST_EXE 不符,检查打包)`);
    }

    // 5. 原子就位
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(staging, finalDir);

    // 6. 平台后处理(mac 去 quarantine / linux chmod +x)
    postProcess(hostKey, finalDir);
    rmSync(archivePath, { force: true });

    const finalExe = cacheExecPath(hostKey)!;
    emit({ hostKey, phase: 'done' });
    return finalExe;
  } catch (e) {
    if (staging) rmSync(staging, { recursive: true, force: true });
    emit({ hostKey, phase: 'error', message: (e as Error).message });
    throw e;
  }
}

/** 下载到 dest,支持断点续传(按已下载字节数发 Range)+ 失败重试。 */
async function downloadWithResume(url: string, dest: string, hostKey: string, maxRetries = 4): Promise<void> {
  let attempt = 0;
  for (;;) {
    attempt++;
    let downloaded = existsSync(dest) ? statSync(dest).size : 0;
    try {
      const headers: Record<string, string> = {};
      if (downloaded > 0) headers['Range'] = `bytes=${downloaded}-`;
      const res = await fetch(url, { headers, redirect: 'follow' });
      if (res.status === 416) {
        // Range 不可满足:多为本地残片损坏 → 清掉重下
        rmSync(dest, { force: true });
        throw new Error('range not satisfiable, restarting');
      }
      if (res.status !== 200 && res.status !== 206) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if (res.status === 200) downloaded = 0; // 服务器忽略 Range,从头写
      if (!res.body) throw new Error('empty response body');
      const contentLen = Number(res.headers.get('content-length') || 0);
      const total = contentLen ? downloaded + contentLen : undefined;
      emit({ hostKey, phase: 'download', received: downloaded, total });

      const out = createWriteStream(dest, { flags: downloaded > 0 ? 'a' : 'w' });
      let received = downloaded;
      let lastEmit = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          const buf = Buffer.from(chunk);
          if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', () => r()));
          received += buf.length;
          if (received - lastEmit >= 4_000_000) {
            emit({ hostKey, phase: 'download', received, total });
            lastEmit = received;
          }
        }
      } finally {
        await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())));
      }
      emit({ hostKey, phase: 'download', received, total });
      return; // 成功
    } catch (e) {
      if (attempt > maxRetries) {
        throw new Error(`下载失败(重试 ${maxRetries} 次后): ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt)); // 退避后按当前文件大小续传
    }
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('data', (d) => h.update(d));
    s.on('end', () => res(h.digest('hex')));
    s.on('error', rej);
  });
}

/** 跨平台解压(shell 出系统工具,零依赖)。工具缺失给可操作报错。 */
function extractArchive(archive: string, dest: string, kind: 'zip' | 'tar.xz'): void {
  if (kind === 'zip' && process.platform === 'darwin') {
    // Chromium.app 含符号链接/资源分叉,ditto 是苹果原生、能正确还原(普通 unzip 可能损坏 .app)
    run('ditto', ['-x', '-k', archive, dest], 'ditto(macOS 自带)');
  } else if (kind === 'zip' && process.platform === 'win32') {
    // Win10+ 自带 bsdtar,可解 zip
    run('tar', ['-xf', archive, '-C', dest], 'tar(Windows 10+ 自带)');
  } else if (kind === 'zip') {
    run('unzip', ['-q', '-o', archive, '-d', dest], 'unzip');
  } else if (kind === 'tar.xz') {
    run('tar', ['-xJf', archive, '-C', dest], 'tar + xz');
  } else {
    throw new Error(`unsupported archive kind: ${kind}`);
  }
}

function run(cmd: string, args: string[], toolLabel: string): void {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(`解压需要 ${toolLabel},但系统未找到 ${cmd};请安装后重试`);
    }
    throw new Error(`解压失败(${cmd}): ${err.message}`);
  }
}

function postProcess(hostKey: string, dir: string): void {
  if (hostKey.startsWith('darwin')) {
    // 下载文件带 com.apple.quarantine,清除避免 Gatekeeper 拦(未签名 .app 严格策略下仍可能拦,另议)
    try {
      execFileSync('xattr', ['-dr', 'com.apple.quarantine', dir], { stdio: 'ignore' });
    } catch {
      // 非致命
    }
  } else if (hostKey.startsWith('linux')) {
    const exe = cacheExecPath(hostKey);
    if (exe) {
      try {
        execFileSync('chmod', ['+x', exe], { stdio: 'ignore' });
      } catch {
        // 非致命
      }
    }
  }
}
