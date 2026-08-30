import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { downloadArchive, extractZipSafely } from '../../archive/secure-archive.js'

/**
 * 安装来源统一 resolve：本地目录 / zip / git URL / HTTP(S) URL / 市场源引用，
 * 统一解析成 staging 目录。remote 标记供可执行技能来源门（策略表）判定。
 */
const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 60_000

export type SkillSourceType = 'dir' | 'zip' | 'git' | 'url' | 'market'

export interface ResolvedSource {
  /** 解析后的技能项目根目录 */
  stagingDir: string
  sourceType: SkillSourceType
  /** 远程来源（git/url/market）：可执行技能需 allowExecutable 门 */
  remote: boolean
  /** 本地目录来源时为原目录名（用于 name-目录名一致校验） */
  sourceDirName?: string
  /** 释放临时产物（本地目录来源为 no-op） */
  cleanup(): Promise<void>
}

export class SourceResolveError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SourceResolveError'
  }
}

/** 市场源引用由 MarketPort 先行解析成具体 git/URL 来源后再进管线 */
export const MARKET_REF_PREFIX = 'market:'

export function classifySource(source: string): SkillSourceType {
  if (source.startsWith(MARKET_REF_PREFIX)) return 'market'
  if (source.startsWith('git@') || source.endsWith('.git')) return 'git'
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return 'url'
  }
  if (source.toLowerCase().endsWith('.zip')) return 'zip'
  return 'dir'
}

export async function resolveSource(source: string): Promise<ResolvedSource> {
  const trimmed = source.trim()
  if (!trimmed) throw new SourceResolveError('安装来源不能为空')

  switch (classifySource(trimmed)) {
    case 'market':
      throw new SourceResolveError(
        `市场源引用需先经市场域解析为具体来源：${trimmed}`,
        { source: trimmed },
      )
    case 'git':
      return cloneGit(trimmed)
    case 'url':
      return downloadUrl(trimmed)
    case 'zip':
      return extractLocalZip(trimmed)
    case 'dir':
      return resolveLocalDir(trimmed)
  }
}

async function resolveLocalDir(source: string): Promise<ResolvedSource> {
  const abs = path.resolve(source)
  let stats
  try {
    stats = await fs.stat(abs)
  } catch {
    throw new SourceResolveError(`来源路径不存在：${abs}`, { source: abs })
  }
  if (!stats.isDirectory()) {
    throw new SourceResolveError(`来源不是目录：${abs}`, { source: abs })
  }
  return {
    stagingDir: abs,
    sourceType: 'dir',
    remote: false,
    sourceDirName: path.basename(abs),
    cleanup: async () => {},
  }
}

async function extractLocalZip(source: string): Promise<ResolvedSource> {
  const abs = path.resolve(source)
  try {
    await fs.access(abs)
  } catch {
    throw new SourceResolveError(`zip 文件不存在：${abs}`, { source: abs })
  }
  const temp = await makeTemp()
  const extractDir = path.join(temp.dir, 'extracted')
  try {
    await extractZipSafely({ archivePath: abs, destination: extractDir })
  } catch (err) {
    await temp.cleanup()
    throw new SourceResolveError(`zip 解压失败：${(err as Error).message}`, { source: abs })
  }
  return {
    stagingDir: await descendSingleRoot(extractDir),
    sourceType: 'zip',
    remote: false,
    cleanup: temp.cleanup,
  }
}

async function cloneGit(url: string): Promise<ResolvedSource> {
  const temp = await makeTemp()
  try {
    await execFileAsync('git', ['clone', '--depth', '1', url, temp.dir], {
      timeout: GIT_TIMEOUT_MS,
    })
  } catch (err) {
    await temp.cleanup()
    throw new SourceResolveError(`git clone 失败：${(err as Error).message}`, { url })
  }
  return { stagingDir: temp.dir, sourceType: 'git', remote: true, cleanup: temp.cleanup }
}

async function downloadUrl(url: string): Promise<ResolvedSource> {
  const temp = await makeTemp()
  const archivePath = path.join(temp.dir, 'download.zip')
  const extractDir = path.join(temp.dir, 'extracted')
  try {
    await downloadArchive({ url, destination: archivePath })
    await extractZipSafely({ archivePath, destination: extractDir })
    return {
      stagingDir: await descendSingleRoot(extractDir),
      sourceType: 'url',
      remote: true,
      cleanup: temp.cleanup,
    }
  } catch (err) {
    await temp.cleanup()
    throw new SourceResolveError(`下载来源失败：${(err as Error).message}`, { url })
  }
}

/** zip/仓库归档常见单根目录包装（且根下无 SKILL.md 时）下钻一层 */
async function descendSingleRoot(dir: string): Promise<string> {
  try {
    await fs.access(path.join(dir, 'SKILL.md'))
    return dir
  } catch {
    // 根下无 SKILL.md：看是否单目录包装
  }
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())
  const files = entries.filter((e) => e.isFile())
  if (dirs.length === 1 && files.length === 0) {
    return path.join(dir, dirs[0].name)
  }
  return dir
}

async function makeTemp(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-skill-'))
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}
