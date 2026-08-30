import { createHash } from 'node:crypto'
import { writeFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { buffer as consumeBuffer } from 'node:stream/consumers'

import { afterEach, describe, expect, it } from 'vitest'
import { ZipFile } from 'yazl'

import { downloadArchive, extractZipSafely } from '../secure-archive.js'

type ZipEntry = {
  name: string
  contents?: string | Buffer
  directory?: boolean
  mode?: number
  compress?: boolean
}

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('secure ZIP extraction', () => {
  it('preflights then extracts nested files and sanitized executable permissions', async () => {
    const root = await temporaryRoot()
    const archivePath = path.join(root, 'fixture.zip')
    const destination = path.join(root, 'extracted')
    await writeFile(archivePath, await zipBuffer([
      { name: 'plugin/' , directory: true },
      { name: 'plugin/SKILL.md', contents: '# Fixture\n' },
      { name: 'plugin/bin/run.sh', contents: '#!/bin/sh\n', mode: 0o104755 },
    ]))

    await expect(extractZipSafely({ archivePath, destination })).resolves.toEqual({
      entries: 3,
      bytes: Buffer.byteLength('# Fixture\n#!/bin/sh\n'),
    })
    await expect(readFile(path.join(destination, 'plugin', 'SKILL.md'), 'utf8')).resolves.toBe('# Fixture\n')
    expect((await stat(path.join(destination, 'plugin', 'bin', 'run.sh'))).mode & 0o777).toBe(0o755)
  })

  it.each([
    ['parent traversal', 'aa/x.txt', '../x.txt'],
    ['absolute path', 'safe.txt', '/abs.txt'],
    ['drive path', 'aa/x.txt', 'C:/x.txt'],
    ['UNC path', 'aaevil.txt', '//evil.txt'],
    ['backslash traversal', 'aa/x.txt', '..\\x.txt'],
  ])('rejects %s before creating the destination', async (_label, safeName, unsafeName) => {
    const root = await temporaryRoot()
    const archivePath = path.join(root, 'malicious.zip')
    const destination = path.join(root, 'extracted')
    const archive = await zipBuffer([
      { name: 'safe/first.txt', contents: 'must not be written' },
      { name: safeName, contents: 'outside' },
    ])
    await writeFile(archivePath, replaceAscii(archive, safeName, unsafeName))

    await expect(extractZipSafely({ archivePath, destination })).rejects.toThrow(/ZIP|path|路径/i)
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['symbolic link', 0o120777],
    ['FIFO', 0o010644],
  ])('rejects a Unix %s entry', async (_label, mode) => {
    const root = await temporaryRoot()
    const archivePath = path.join(root, 'special.zip')
    const destination = path.join(root, 'extracted')
    await writeFile(archivePath, await zipBuffer([
      { name: 'plugin/link', contents: '../outside', mode },
    ]))

    await expect(extractZipSafely({ archivePath, destination })).rejects.toThrow('链接或特殊文件')
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    {
      name: 'case-insensitive duplicate paths',
      entries: [
        { name: 'Plugin/file.txt', contents: 'one' },
        { name: 'plugin/FILE.TXT', contents: 'two' },
      ],
    },
    {
      name: 'file-directory conflicts',
      entries: [
        { name: 'plugin', contents: 'file' },
        { name: 'plugin/child.txt', contents: 'child' },
      ],
    },
  ])('rejects $name', async ({ entries }) => {
    const root = await temporaryRoot()
    const archivePath = path.join(root, 'conflict.zip')
    const destination = path.join(root, 'extracted')
    await writeFile(archivePath, await zipBuffer(entries))

    await expect(extractZipSafely({ archivePath, destination })).rejects.toThrow(/重复|冲突/)
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    {
      label: 'single-file size',
      entries: [{ name: 'one.txt', contents: '12345' }],
      limits: { maxFileBytes: 4 },
      message: 'ZIP 文件超过',
    },
    {
      label: 'total extracted size',
      entries: [
        { name: 'one.txt', contents: '123' },
        { name: 'two.txt', contents: '456' },
      ],
      limits: { maxTotalBytes: 5 },
      message: 'ZIP 解压总大小超过',
    },
    {
      label: 'entry count',
      entries: [
        { name: 'one.txt', contents: '1' },
        { name: 'two.txt', contents: '2' },
      ],
      limits: { maxEntries: 1 },
      message: 'ZIP 条目数超过',
    },
  ])('enforces the $label limit before writing', async ({ entries, limits, message }) => {
    const root = await temporaryRoot()
    const archivePath = path.join(root, 'limited.zip')
    const destination = path.join(root, 'extracted')
    await writeFile(archivePath, await zipBuffer(entries))

    await expect(extractZipSafely({ archivePath, destination, limits })).rejects.toThrow(message)
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('checks actual file data with CRC-32 and removes the partial destination', async () => {
    const root = await temporaryRoot()
    const archivePath = path.join(root, 'corrupt.zip')
    const destination = path.join(root, 'extracted')
    const archive = await zipBuffer([{ name: 'payload.txt', contents: 'original', compress: false }])
    const fileNameLength = archive.readUInt16LE(26)
    const extraLength = archive.readUInt16LE(28)
    const dataOffset = 30 + fileNameLength + extraLength
    archive[dataOffset] ^= 0xff
    await writeFile(archivePath, archive)

    await expect(extractZipSafely({ archivePath, destination })).rejects.toThrow('CRC-32')
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never removes or reuses a destination that already exists', async () => {
    const root = await temporaryRoot()
    const archivePath = path.join(root, 'fixture.zip')
    const destination = path.join(root, 'existing')
    await writeFile(archivePath, await zipBuffer([{ name: 'file.txt', contents: 'new' }]))
    await writeFile(destination, 'owned by caller')

    await expect(extractZipSafely({ archivePath, destination })).rejects.toThrow('必须尚不存在')
    await expect(readFile(destination, 'utf8')).resolves.toBe('owned by caller')
  })
})

describe('streaming archive download', () => {
  it('allows localhost HTTP and cross-origin redirects while streaming and hashing', async () => {
    const archive = await zipBuffer([{ name: 'plugin/file.txt', contents: 'downloaded' }])
    const final = await listen((_request, response) => {
      response.write(archive.subarray(0, 7))
      response.end(archive.subarray(7))
    })
    const redirect = await listen((_request, response) => {
      response.writeHead(302, { location: `${final}/plugin.zip` })
      response.end()
    })
    const root = await temporaryRoot()
    const destination = path.join(root, 'download.zip')
    const expectedSha256 = createHash('sha256').update(archive).digest('hex')

    await expect(downloadArchive({
      url: `${redirect}/redirect`,
      destination,
      expectedSha256,
    })).resolves.toEqual({
      bytes: archive.byteLength,
      sha256: expectedSha256,
      finalUrl: `${final}/plugin.zip`,
    })
    await expect(readFile(destination)).resolves.toEqual(archive)
  })

  it('rejects an oversized declared Content-Length without creating a file', async () => {
    const server = await listen((_request, response) => {
      response.writeHead(200, { 'content-length': '100' })
      response.end(Buffer.alloc(100))
    })
    const root = await temporaryRoot()
    const destination = path.join(root, 'download.zip')

    await expect(downloadArchive({ url: server, destination, maxBytes: 10 })).rejects.toThrow('超过')
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enforces the actual-byte limit for chunked responses and removes the partial file', async () => {
    const server = await listen((_request, response) => {
      response.write(Buffer.alloc(6))
      response.end(Buffer.alloc(6))
    })
    const root = await temporaryRoot()
    const destination = path.join(root, 'download.zip')

    await expect(downloadArchive({ url: server, destination, maxBytes: 10 })).rejects.toThrow('超过')
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the timeout active through the response body', async () => {
    const server = await listen((_request, response) => {
      response.write('started')
      setTimeout(() => response.end('finished'), 250)
    })
    const root = await temporaryRoot()
    const destination = path.join(root, 'download.zip')

    await expect(downloadArchive({ url: server, destination, timeoutMs: 30 })).rejects.toThrow('下载超时')
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a completed download when SHA-256 does not match', async () => {
    const server = await listen((_request, response) => response.end('archive'))
    const root = await temporaryRoot()
    const destination = path.join(root, 'download.zip')

    await expect(downloadArchive({
      url: server,
      destination,
      expectedSha256: '0'.repeat(64),
    })).rejects.toThrow('SHA-256 校验失败')
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-secure-archive-'))
  roots.push(root)
  return root
}

async function zipBuffer(entries: ZipEntry[]): Promise<Buffer> {
  const zip = new ZipFile()
  for (const entry of entries) {
    if (entry.directory) {
      zip.addEmptyDirectory(entry.name, entry.mode === undefined ? undefined : { mode: entry.mode })
      continue
    }
    zip.addBuffer(
      Buffer.isBuffer(entry.contents) ? entry.contents : Buffer.from(entry.contents ?? ''),
      entry.name,
      {
        ...(entry.mode === undefined ? {} : { mode: entry.mode }),
        ...(entry.compress === undefined ? {} : { compress: entry.compress }),
      },
    )
  }
  const output = consumeBuffer(zip.outputStream as Readable)
  zip.end()
  return output
}

function replaceAscii(source: Buffer, before: string, after: string): Buffer {
  const beforeBytes = Buffer.from(before)
  const afterBytes = Buffer.from(after)
  if (beforeBytes.byteLength !== afterBytes.byteLength) throw new Error('fixture names must have equal byte lengths')
  const result = Buffer.from(source)
  let count = 0
  let offset = 0
  while ((offset = result.indexOf(beforeBytes, offset)) !== -1) {
    afterBytes.copy(result, offset)
    offset += afterBytes.byteLength
    count += 1
  }
  if (count !== 2) throw new Error(`expected two ZIP filename records, found ${count}`)
  return result
}

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}
