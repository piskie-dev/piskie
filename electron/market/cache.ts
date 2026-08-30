import { createUuid } from '@shared/utils/identifiers.js';
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import type { MarketEntry, MarketSource } from '@shared/types/market.js'

const execFileAsync = promisify(execFile)
const CACHE_TTL_MS = 24 * 60 * 60_000

interface CacheDocument {
  sourceId: string
  refreshedAt: string
  revision?: string
  etag?: string
  entries: MarketEntry[]
  warnings: string[]
}

export function marketCacheRoot(configRoot: string): string {
  return path.join(configRoot, 'market-cache')
}

export function marketSourceCacheDir(configRoot: string, sourceId: string): string {
  const slug = sourceId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48)
  const hash = createHash('sha1').update(sourceId).digest('hex').slice(0, 10)
  return path.join(marketCacheRoot(configRoot), `${slug}-${hash}`)
}

export function marketCheckoutDir(configRoot: string, sourceId: string): string {
  return path.join(marketSourceCacheDir(configRoot, sourceId), 'checkout')
}

function cacheFile(configRoot: string, sourceId: string): string {
  return path.join(marketSourceCacheDir(configRoot, sourceId), 'catalog.json')
}

export async function readMarketCache(
  configRoot: string,
  sourceId: string,
): Promise<CacheDocument | undefined> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(cacheFile(configRoot, sourceId), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const value = raw as Partial<CacheDocument>
    if (!Array.isArray(value.entries) || typeof value.refreshedAt !== 'string') return undefined
    return {
      sourceId,
      refreshedAt: value.refreshedAt,
      revision: value.revision,
      etag: value.etag,
      entries: value.entries,
      warnings: Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === 'string') : [],
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function marketCacheIsStale(cache: CacheDocument | undefined): boolean {
  return !cache || Date.now() - Date.parse(cache.refreshedAt) > CACHE_TTL_MS
}

export async function writeMarketCache(
  configRoot: string,
  sourceId: string,
  value: Omit<CacheDocument, 'sourceId' | 'refreshedAt'> & { refreshedAt?: string },
): Promise<void> {
  const directory = marketSourceCacheDir(configRoot, sourceId)
  await fs.mkdir(directory, { recursive: true })
  const file = cacheFile(configRoot, sourceId)
  const temporary = `${file}.${process.pid}.${createUuid()}.tmp`
  const document: CacheDocument = {
    sourceId,
    refreshedAt: value.refreshedAt ?? new Date().toISOString(),
    revision: value.revision,
    etag: value.etag,
    entries: value.entries,
    warnings: value.warnings,
  }
  await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, file)
}

/** Git 源刷新到独立 candidate，成功后才原子替换 checkout。 */
export async function refreshGitCheckout(configRoot: string, source: MarketSource): Promise<{
  checkout: string
  revision?: string
}> {
  const cacheDir = marketSourceCacheDir(configRoot, source.id)
  const checkout = marketCheckoutDir(configRoot, source.id)
  const transactionRoot = path.join(cacheDir, '.tmp')
  const candidate = path.join(transactionRoot, `checkout-${createUuid()}`)
  const backup = path.join(transactionRoot, `backup-${createUuid()}`)
  await fs.mkdir(transactionRoot, { recursive: true })

  const local = await localDirectory(source.url)
  try {
    if (local) {
      await fs.cp(local, candidate, {
        recursive: true,
        filter: (item) => path.basename(item) !== '.git',
      })
    } else {
      const args = ['clone', '--depth', '1']
      if (source.ref) args.push('--branch', source.ref)
      args.push(normalizeGitUrl(source.url), candidate)
      await execFileAsync('git', args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    }
    const revision = local
      ? await directoryFingerprint(candidate)
      : await execFileAsync('git', ['-C', candidate, 'rev-parse', 'HEAD'])
        .then(({ stdout }) => stdout.trim())
        .catch(() => undefined)
    if (await exists(checkout)) await fs.rename(checkout, backup)
    await fs.rename(candidate, checkout)
    await fs.rm(backup, { recursive: true, force: true })
    return { checkout, revision }
  } catch (error) {
    await fs.rm(candidate, { recursive: true, force: true }).catch(() => undefined)
    if (!(await exists(checkout)) && await exists(backup)) {
      await fs.rename(backup, checkout).catch(() => undefined)
    }
    throw error
  }
}

function normalizeGitUrl(url: string): string {
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(url) && !url.endsWith('.git')) {
    return `${url.replace(/\/$/, '')}.git`
  }
  return url
}

async function localDirectory(value: string): Promise<string | undefined> {
  if (/^(https?:\/\/|git@)/.test(value)) return undefined
  const resolved = path.resolve(value)
  try {
    return (await fs.stat(resolved)).isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

async function directoryFingerprint(directory: string): Promise<string> {
  const hash = createHash('sha1')
  const visit = async (root: string): Promise<void> => {
    const entries = await fs.readdir(root, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue
      const file = path.join(root, entry.name)
      hash.update(path.relative(directory, file))
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) hash.update(await fs.readFile(file))
    }
  }
  await visit(directory)
  return hash.digest('hex')
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
