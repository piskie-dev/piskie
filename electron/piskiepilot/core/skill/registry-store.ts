import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { SkillRegistryFile } from '@shared/types/skill.js'

/**
 * registry.json 读写与修订号 CAS。
 *
 * 写者跨进程（app 内安装、CLI、插件级联）：写入走锁文件（O_EXCL）串行化，
 * 锁内重读最新内容 → mutator → revision+1 → temp+rename 原子替换。
 * 陈旧锁（持有超过 STALE_LOCK_MS）视为死写者遗留，抢占。
 */
const REGISTRY_FILE = 'registry.json'
const LOCK_SUFFIX = '.lock'
const STALE_LOCK_MS = 10_000
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5_000

export class RegistryLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`获取 registry 锁超时：${lockPath}`)
    this.name = 'RegistryLockTimeoutError'
  }
}

export function emptyRegistry(): SkillRegistryFile {
  return { version: '1.0', revision: 0, skills: {} }
}

export async function readRegistry(skillsRoot: string): Promise<SkillRegistryFile> {
  const file = path.join(skillsRoot, REGISTRY_FILE)
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry()
    throw err
  }
  return normalize(JSON.parse(text))
}

/** 旧形状（无 revision）升级为 revision 0；字段缺失兜底 */
function normalize(raw: unknown): SkillRegistryFile {
  const obj = (raw ?? {}) as Partial<SkillRegistryFile> & Record<string, unknown>
  return {
    version: typeof obj.version === 'string' ? obj.version : '1.0',
    revision: typeof obj.revision === 'number' && Number.isInteger(obj.revision) ? obj.revision : 0,
    skills: obj.skills && typeof obj.skills === 'object' ? (obj.skills as SkillRegistryFile['skills']) : {},
  }
}

export interface UpdateOptions {
  /** 显式 CAS：与锁内重读到的 revision 不一致时抛 RevisionConflictError（缺省不校验，锁内串行即可） */
  expectedRevision?: number
}

export class RevisionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`registry revision 冲突：期望 ${expected}，实际 ${actual}`)
    this.name = 'RevisionConflictError'
  }
}

export async function updateRegistry(
  skillsRoot: string,
  mutate: (draft: SkillRegistryFile) => void | Promise<void>,
  options: UpdateOptions = {},
): Promise<SkillRegistryFile> {
  const file = path.join(skillsRoot, REGISTRY_FILE)
  const lockPath = file + LOCK_SUFFIX
  await fs.mkdir(skillsRoot, { recursive: true })
  await acquireLock(lockPath)
  try {
    const current = await readRegistry(skillsRoot)
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      throw new RevisionConflictError(options.expectedRevision, current.revision)
    }
    await mutate(current)
    current.revision += 1
    await atomicWrite(file, JSON.stringify(current, null, 2))
    return current
  } finally {
    await releaseLock(lockPath)
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
      await handle.close()
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (await stealIfStale(lockPath)) continue
      if (Date.now() > deadline) throw new RegistryLockTimeoutError(lockPath)
      await sleep(LOCK_RETRY_MS)
    }
  }
}

async function stealIfStale(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath)
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
      await fs.unlink(lockPath)
      return true
    }
  } catch {
    return true // 锁已被释放，立刻重试
  }
  return false
}

async function releaseLock(lockPath: string): Promise<void> {
  await fs.unlink(lockPath).catch(() => {})
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, file)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
