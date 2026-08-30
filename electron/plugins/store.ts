import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { PluginRecord, PluginsFile } from '@shared/types/plugin.js'

const STORE_FILE = 'plugins.json'
const STALE_LOCK_MS = 10_000
const LOCK_TIMEOUT_MS = 5_000
const LOCK_RETRY_MS = 25

export class PluginsStoreLockTimeoutError extends Error {
  constructor(file: string) {
    super(`获取 plugins.json 锁超时：${file}`)
    this.name = 'PluginsStoreLockTimeoutError'
  }
}

export class PluginsRevisionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`plugins revision 冲突：期望 ${expected}，实际 ${actual}`)
    this.name = 'PluginsRevisionConflictError'
  }
}

export function pluginsStorePath(configRoot: string): string {
  return path.join(configRoot, STORE_FILE)
}

export function globalPluginsRoot(configRoot: string): string {
  return path.join(configRoot, 'plugins')
}

export function globalPluginDir(configRoot: string, name: string): string {
  return path.join(globalPluginsRoot(configRoot), name)
}

export function pluginDataRoot(configRoot: string): string {
  return path.join(configRoot, 'plugin-data')
}

export function pluginDataDir(configRoot: string, name: string): string {
  return path.join(pluginDataRoot(configRoot), name)
}

export function emptyPluginsFile(): PluginsFile {
  return { revision: 0, plugins: [] }
}

export async function readPluginsFile(configRoot: string): Promise<PluginsFile> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(pluginsStorePath(configRoot), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyPluginsFile()
    throw error
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyPluginsFile()
  const value = raw as Partial<PluginsFile>
  return {
    revision: Number.isInteger(value.revision) ? value.revision! : 0,
    plugins: Array.isArray(value.plugins)
      ? value.plugins.filter(isPluginRecord)
      : [],
  }
}

function isPluginRecord(value: unknown): value is PluginRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<PluginRecord>
  return typeof item.name === 'string'
    && typeof item.source === 'string'
    && (item.scope === 'user' || item.scope === 'project')
    && typeof item.path === 'string'
    && typeof item.installedAt === 'string'
    && Boolean(item.members)
    && Array.isArray(item.members?.skills)
    && Array.isArray(item.members?.mcpServers)
}

export async function updatePluginsFile(
  configRoot: string,
  mutate: (draft: PluginsFile) => void | Promise<void>,
  options: { expectedRevision?: number } = {},
): Promise<PluginsFile> {
  const file = pluginsStorePath(configRoot)
  const lock = `${file}.lock`
  await fs.mkdir(configRoot, { recursive: true })
  await acquireLock(lock)
  try {
    const current = await readPluginsFile(configRoot)
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      throw new PluginsRevisionConflictError(options.expectedRevision, current.revision)
    }
    await mutate(current)
    current.revision += 1
    await atomicWrite(file, `${JSON.stringify(current, null, 2)}\n`)
    return current
  } finally {
    await fs.unlink(lock).catch(() => undefined)
  }
}

async function acquireLock(lock: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
      await handle.close()
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const stat = await fs.stat(lock)
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fs.unlink(lock)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) throw new PluginsStoreLockTimeoutError(lock)
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(temporary, contents, 'utf8')
  await fs.rename(temporary, file)
}
