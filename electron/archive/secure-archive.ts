import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { crc32 } from 'node:zlib'

import { openPromise, type Entry } from 'yauzl'

export const DEFAULT_ARCHIVE_LIMITS = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxEntries: 10_000,
} as const

export const DEFAULT_ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000

export interface ArchiveExtractionLimits {
  maxArchiveBytes: number
  maxFileBytes: number
  maxTotalBytes: number
  maxEntries: number
}

export interface DownloadArchiveOptions {
  url: string
  destination: string
  expectedSha256?: string
  maxBytes?: number
  timeoutMs?: number
}

export interface DownloadArchiveResult {
  bytes: number
  sha256: string
  finalUrl: string
}

export interface ExtractZipOptions {
  archivePath: string
  destination: string
  limits?: Partial<ArchiveExtractionLimits>
}

export interface ExtractZipResult {
  entries: number
  bytes: number
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveError'
  }
}

export async function downloadArchive(options: DownloadArchiveOptions): Promise<DownloadArchiveResult> {
  const url = parseHttpUrl(options.url)
  const expectedSha256 = normalizeExpectedSha256(options.expectedSha256)
  const maxBytes = positiveLimit(options.maxBytes ?? DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes, '下载大小')
  const timeoutMs = positiveLimit(options.timeoutMs ?? DEFAULT_ARCHIVE_DOWNLOAD_TIMEOUT_MS, '下载超时')
  const controller = new AbortController()
  let timedOut = false
  let destinationHandle: FileHandle | undefined
  let destinationCreated = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new ArchiveError(`下载失败：HTTP ${response.status} ${response.statusText}`)
    if (!response.body) throw new ArchiveError('下载失败：响应没有内容')

    const finalUrl = parseHttpUrl(response.url).toString()
    const declaredLength = parseContentLength(response.headers.get('content-length'))
    if (declaredLength !== undefined && declaredLength > maxBytes) {
      throw new ArchiveError(`下载归档超过 ${formatBytes(maxBytes)} 上限`)
    }

    destinationHandle = await fs.open(options.destination, 'wx', 0o600)
    destinationCreated = true
    const digest = createHash('sha256')
    const reader = response.body.getReader()
    let bytes = 0

    try {
      let next = await reader.read()
      while (!next.done) {
        const chunk = Buffer.from(next.value)
        if (bytes + chunk.byteLength > maxBytes) {
          controller.abort()
          throw new ArchiveError(`下载归档超过 ${formatBytes(maxBytes)} 上限`)
        }
        await writeAll(destinationHandle, chunk)
        digest.update(chunk)
        bytes += chunk.byteLength
        next = await reader.read()
      }
    } finally {
      reader.releaseLock()
    }

    await destinationHandle.close()
    destinationHandle = undefined
    const sha256 = digest.digest('hex')
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      throw new ArchiveError(`SHA-256 校验失败：期望 ${expectedSha256}，得到 ${sha256}`)
    }
    return { bytes, sha256, finalUrl }
  } catch (error) {
    controller.abort()
    if (destinationHandle !== undefined) await destinationHandle.close().catch(() => {})
    if (destinationCreated) await fs.rm(options.destination, { force: true }).catch(() => {})
    if (timedOut) throw new ArchiveError(`下载超时（${timeoutMs} ms）`)
    if (error instanceof ArchiveError) throw error
    throw new ArchiveError(`下载失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function extractZipSafely(options: ExtractZipOptions): Promise<ExtractZipResult> {
  const limits = normalizeLimits(options.limits)
  const archive = await fs.stat(options.archivePath).catch((error: unknown) => {
    throw new ArchiveError(`无法读取 ZIP：${error instanceof Error ? error.message : String(error)}`)
  })
  if (!archive.isFile()) throw new ArchiveError('ZIP 来源不是普通文件')
  if (archive.size > limits.maxArchiveBytes) {
    throw new ArchiveError(`ZIP 超过 ${formatBytes(limits.maxArchiveBytes)} 上限`)
  }
  await assertDestinationDoesNotExist(options.destination)

  const zip = await openPromise(options.archivePath, {
    autoClose: false,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true,
  }).catch((error: unknown) => {
    throw new ArchiveError(`ZIP 格式无效：${error instanceof Error ? error.message : String(error)}`)
  })

  let destinationCreated = false
  try {
    const entries = await preflightEntries(zip.eachEntry(), options.destination, limits)
    await fs.mkdir(options.destination, { mode: 0o700 })
    destinationCreated = true

    for (const item of entries) {
      if (item.kind !== 'directory') continue
      await fs.mkdir(item.outputPath, { recursive: true, mode: item.mode })
      await fs.chmod(item.outputPath, item.mode)
    }

    let totalBytes = 0
    for (const item of entries) {
      if (item.kind !== 'file') continue
      await fs.mkdir(path.dirname(item.outputPath), { recursive: true, mode: 0o700 })
      totalBytes += await extractFile(zip, item, limits, totalBytes)
    }

    return { entries: entries.length, bytes: totalBytes }
  } catch (error) {
    if (destinationCreated) {
      await fs.rm(options.destination, { recursive: true, force: true }).catch(() => {})
    }
    if (error instanceof ArchiveError) throw error
    throw new ArchiveError(`ZIP 解压失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    zip.close()
  }
}

type PlannedEntry = {
  entry: Entry
  kind: 'file' | 'directory'
  outputPath: string
  portablePath: string
  mode: number
}

type RegisteredPath = {
  kind: 'file' | 'directory'
  explicit: boolean
  displayPath: string
}

async function preflightEntries(
  source: AsyncIterable<Entry>,
  destination: string,
  limits: ArchiveExtractionLimits,
): Promise<PlannedEntry[]> {
  const entries: PlannedEntry[] = []
  const registered = new Map<string, RegisteredPath>()
  let declaredTotal = 0

  for await (const entry of source) {
    if (entries.length >= limits.maxEntries) {
      throw new ArchiveError(`ZIP 条目数超过 ${limits.maxEntries} 上限`)
    }
    const item = inspectEntry(entry, destination)
    registerPortablePath(item, registered)

    if (item.kind === 'file') {
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
        throw new ArchiveError(`ZIP 条目大小无效：${item.portablePath}`)
      }
      if (entry.uncompressedSize > limits.maxFileBytes) {
        throw new ArchiveError(`ZIP 文件超过 ${formatBytes(limits.maxFileBytes)} 上限：${item.portablePath}`)
      }
      declaredTotal += entry.uncompressedSize
      if (!Number.isSafeInteger(declaredTotal) || declaredTotal > limits.maxTotalBytes) {
        throw new ArchiveError(`ZIP 解压总大小超过 ${formatBytes(limits.maxTotalBytes)} 上限`)
      }
    }
    entries.push(item)
  }

  return entries
}

function inspectEntry(entry: Entry, destination: string): PlannedEntry {
  const portablePath = validatePortablePath(entry.fileName)
  if (entry.isEncrypted()) throw new ArchiveError(`ZIP 不支持加密条目：${portablePath}`)
  if (!entry.canDecodeFileData()) {
    throw new ArchiveError(`ZIP 使用不支持的压缩方式：${portablePath}`)
  }

  const host = entry.versionMadeBy >>> 8
  const unixMode = host === 3 || host === 19
    ? (entry.externalFileAttributes >>> 16) & 0xffff
    : undefined
  const unixType = unixMode === undefined ? 0 : unixMode & 0o170000
  if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
    throw new ArchiveError(`ZIP 包含链接或特殊文件：${portablePath}`)
  }

  const trailingSlash = entry.fileName.endsWith('/')
  const metadataDirectory = unixType === 0o040000 || (entry.externalFileAttributes & 0x10) !== 0
  if (unixType === 0o100000 && trailingSlash) {
    throw new ArchiveError(`ZIP 条目类型与路径不一致：${portablePath}`)
  }
  const kind = trailingSlash || metadataDirectory ? 'directory' : 'file'
  if (kind === 'directory' && (entry.uncompressedSize !== 0 || entry.compressedSize !== 0)) {
    throw new ArchiveError(`ZIP 目录条目包含文件数据：${portablePath}`)
  }

  const outputPath = path.resolve(destination, ...portablePath.split('/'))
  assertContained(destination, outputPath, portablePath)
  return {
    entry,
    kind,
    outputPath,
    portablePath,
    mode: sanitizedMode(kind, unixMode),
  }
}

function validatePortablePath(value: string): string {
  if (!value || value.includes('\0')) throw new ArchiveError('ZIP 包含空路径或 NUL 字符')
  if (value.includes('\\')) throw new ArchiveError(`ZIP 路径包含反斜杠：${value}`)
  if (value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:/.test(value)) {
    throw new ArchiveError(`ZIP 包含绝对路径：${value}`)
  }

  const withoutTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value
  const segments = withoutTrailingSlash.split('/')
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ArchiveError(`ZIP 包含越界或非规范路径：${value}`)
  }
  for (const segment of segments) validatePortableSegment(segment, value)
  return segments.join('/')
}

function validatePortableSegment(segment: string, fullPath: string): void {
  const hasControlCharacter = Array.from(segment).some((character) => character.charCodeAt(0) <= 0x1f)
  if (hasControlCharacter || /[<>:"|?*]/.test(segment) || /[ .]$/.test(segment)) {
    throw new ArchiveError(`ZIP 路径无法安全跨平台使用：${fullPath}`)
  }
  const stem = segment.split('.')[0].toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw new ArchiveError(`ZIP 路径使用 Windows 保留名称：${fullPath}`)
  }
}

function registerPortablePath(item: PlannedEntry, registered: Map<string, RegisteredPath>): void {
  const segments = item.portablePath.split('/')
  for (let index = 1; index < segments.length; index += 1) {
    const displayPath = segments.slice(0, index).join('/')
    const key = portablePathKey(displayPath)
    const existing = registered.get(key)
    if (existing?.kind === 'file') {
      throw new ArchiveError(`ZIP 文件与目录路径冲突：${existing.displayPath} / ${item.portablePath}`)
    }
    if (existing === undefined) {
      registered.set(key, { kind: 'directory', explicit: false, displayPath })
    }
  }

  const key = portablePathKey(item.portablePath)
  const existing = registered.get(key)
  if (existing !== undefined) {
    if (existing.kind !== item.kind || item.kind === 'file' || existing.explicit) {
      throw new ArchiveError(`ZIP 包含重复或冲突路径：${existing.displayPath} / ${item.portablePath}`)
    }
    existing.explicit = true
    return
  }
  registered.set(key, {
    kind: item.kind,
    explicit: true,
    displayPath: item.portablePath,
  })
}

function portablePathKey(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

async function extractFile(
  zip: Awaited<ReturnType<typeof openPromise>>,
  item: PlannedEntry,
  limits: ArchiveExtractionLimits,
  priorTotalBytes: number,
): Promise<number> {
  const input = await zip.openReadStreamPromise(item.entry)
  let output: FileHandle | undefined
  let fileBytes = 0
  let checksum = 0

  try {
    output = await fs.open(item.outputPath, 'wx', item.mode)
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
      fileBytes += chunk.byteLength
      if (fileBytes > limits.maxFileBytes) {
        throw new ArchiveError(`ZIP 文件超过 ${formatBytes(limits.maxFileBytes)} 上限：${item.portablePath}`)
      }
      if (priorTotalBytes + fileBytes > limits.maxTotalBytes) {
        throw new ArchiveError(`ZIP 解压总大小超过 ${formatBytes(limits.maxTotalBytes)} 上限`)
      }
      checksum = crc32(chunk, checksum)
      await writeAll(output, chunk)
    }
    await output.close()
    output = undefined
    if (fileBytes !== item.entry.uncompressedSize) {
      throw new ArchiveError(`ZIP 条目实际大小与声明不符：${item.portablePath}`)
    }
    if ((checksum >>> 0) !== (item.entry.crc32 >>> 0)) {
      throw new ArchiveError(`ZIP 条目 CRC-32 校验失败：${item.portablePath}`)
    }
    return fileBytes
  } finally {
    input.destroy()
    if (output !== undefined) await output.close().catch(() => {})
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
    if (bytesWritten === 0) throw new ArchiveError('写入归档内容失败')
    offset += bytesWritten
  }
}

function parseHttpUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ArchiveError(`归档 URL 无效：${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ArchiveError('归档 URL 必须使用 HTTP 或 HTTPS')
  }
  return url
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const length = Number(value)
  return Number.isSafeInteger(length) ? length : undefined
}

function normalizeExpectedSha256(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new ArchiveError('期望 SHA-256 必须是 64 位十六进制')
  return value.toLowerCase()
}

function normalizeLimits(overrides: Partial<ArchiveExtractionLimits> | undefined): ArchiveExtractionLimits {
  return {
    maxArchiveBytes: positiveLimit(
      overrides?.maxArchiveBytes ?? DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes,
      'ZIP 大小',
    ),
    maxFileBytes: positiveLimit(
      overrides?.maxFileBytes ?? DEFAULT_ARCHIVE_LIMITS.maxFileBytes,
      '单文件大小',
    ),
    maxTotalBytes: positiveLimit(
      overrides?.maxTotalBytes ?? DEFAULT_ARCHIVE_LIMITS.maxTotalBytes,
      '解压总大小',
    ),
    maxEntries: positiveLimit(overrides?.maxEntries ?? DEFAULT_ARCHIVE_LIMITS.maxEntries, 'ZIP 条目数'),
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ArchiveError(`${name}上限无效`)
  return value
}

async function assertDestinationDoesNotExist(destination: string): Promise<void> {
  try {
    await fs.lstat(destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new ArchiveError(`无法检查解压目录：${error instanceof Error ? error.message : String(error)}`)
  }
  throw new ArchiveError(`解压目录必须尚不存在：${destination}`)
}

function assertContained(root: string, candidate: string, displayPath: string): void {
  const relative = path.relative(path.resolve(root), candidate)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ArchiveError(`ZIP 路径越过解压目录：${displayPath}`)
  }
}

function sanitizedMode(kind: 'file' | 'directory', unixMode: number | undefined): number {
  const permissions = unixMode === undefined || (unixMode & 0o777) === 0
    ? kind === 'directory' ? 0o755 : 0o644
    : unixMode & 0o777
  return kind === 'directory' ? permissions | 0o700 : permissions
}

function formatBytes(value: number): string {
  if (value % (1024 * 1024) === 0) return `${value / (1024 * 1024)} MiB`
  return `${value} 字节`
}
