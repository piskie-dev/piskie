import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { buffer as consumeBuffer } from 'node:stream/consumers'

import { afterEach, describe, expect, it } from 'vitest'
import { ZipFile } from 'yazl'

import { resolveSource } from '../sources.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill ZIP source resolution', () => {
  it('uses the safe owner for local ZIP files and descends a single root', async () => {
    const root = await temporaryRoot()
    const archive = path.join(root, 'fixture.zip')
    await writeFile(archive, await skillZip())

    const resolved = await resolveSource(archive)
    try {
      expect(resolved).toMatchObject({ sourceType: 'zip', remote: false })
      await expect(readFile(path.join(resolved.stagingDir, 'SKILL.md'), 'utf8'))
        .resolves.toContain('name: archive-skill')
    } finally {
      await resolved.cleanup()
    }
  })

  it('allows an internal HTTP ZIP source and streams it through the same owner', async () => {
    const archive = await skillZip()
    const url = await listen(archive)

    const resolved = await resolveSource(`${url}/skill.zip`)
    try {
      expect(resolved).toMatchObject({ sourceType: 'url', remote: true })
      await expect(readFile(path.join(resolved.stagingDir, 'SKILL.md'), 'utf8'))
        .resolves.toContain('name: archive-skill')
    } finally {
      await resolved.cleanup()
    }
  })

  it('rejects a traversal ZIP through the public skill source entry', async () => {
    const root = await temporaryRoot()
    const archivePath = path.join(root, 'malicious.zip')
    const safe = await zip([{ name: 'aa/out.txt', contents: 'escaped' }])
    await writeFile(archivePath, replaceAscii(safe, 'aa/out.txt', '../out.txt'))

    await expect(resolveSource(archivePath)).rejects.toThrow(/zip 解压失败|relative path|越界/)
    await expect(stat(path.join(root, 'out.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

async function skillZip(): Promise<Buffer> {
  return zip([
    {
      name: 'archive-skill/SKILL.md',
      contents: '---\nname: archive-skill\ndescription: Archive fixture\n---\n',
    },
  ])
}

async function zip(entries: Array<{ name: string; contents: string }>): Promise<Buffer> {
  const archive = new ZipFile()
  for (const entry of entries) archive.addBuffer(Buffer.from(entry.contents), entry.name)
  const output = consumeBuffer(archive.outputStream as Readable)
  archive.end()
  return output
}

function replaceAscii(source: Buffer, before: string, after: string): Buffer {
  const result = Buffer.from(source)
  const beforeBytes = Buffer.from(before)
  const afterBytes = Buffer.from(after)
  if (beforeBytes.byteLength !== afterBytes.byteLength) throw new Error('fixture names must have equal lengths')
  let offset = 0
  let count = 0
  while ((offset = result.indexOf(beforeBytes, offset)) !== -1) {
    afterBytes.copy(result, offset)
    offset += afterBytes.byteLength
    count += 1
  }
  if (count !== 2) throw new Error(`expected two ZIP filename records, found ${count}`)
  return result
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-skill-source-test-'))
  roots.push(root)
  return root
}

async function listen(contents: Buffer): Promise<string> {
  const server = createServer((_request, response) => {
    response.write(contents.subarray(0, 5))
    response.end(contents.subarray(5))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
