import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { buffer as consumeBuffer } from 'node:stream/consumers'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'
import { ZipFile } from 'yazl'

import { pluginPackageSourceLabel, resolvePluginPackageSource } from '../adapter-source.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('plugin package source resolver', () => {
  it('uses sha ahead of ref and preserves the requested git subdirectory', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'piskie-plugin-source-repo-'))
    roots.push(repository)
    await execFileAsync('git', ['init', '-b', 'main', repository])
    await execFileAsync('git', ['-C', repository, 'config', 'user.name', 'Piskie Test'])
    await execFileAsync('git', ['-C', repository, 'config', 'user.email', 'piskie@example.test'])
    await mkdir(path.join(repository, 'plugins', 'fixture'), { recursive: true })
    await writeFile(path.join(repository, 'plugins', 'fixture', 'version.txt'), 'v1', 'utf8')
    await execFileAsync('git', ['-C', repository, 'add', '.'])
    await execFileAsync('git', ['-C', repository, 'commit', '-m', 'v1'])
    const first = (await execFileAsync('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim()
    await writeFile(path.join(repository, 'plugins', 'fixture', 'version.txt'), 'v2', 'utf8')
    await execFileAsync('git', ['-C', repository, 'commit', '-am', 'v2'])

    const source = {
      type: 'git' as const,
      url: repository,
      ref: 'main',
      sha: first,
      subdirectory: 'plugins/fixture',
    }
    const resolved = await resolvePluginPackageSource(source)
    try {
      await expect(readFile(path.join(resolved.directory, 'version.txt'), 'utf8')).resolves.toBe('v1')
      expect(pluginPackageSourceLabel(source)).toContain(`#${first}:plugins/fixture`)
    } finally {
      await resolved.cleanup()
    }
  })

  it('downloads a digest-pinned plugin archive from an internal HTTP endpoint', async () => {
    const archive = await zip([
      { name: 'plugin/.claude-plugin/plugin.json', contents: '{"name":"http-plugin"}' },
      { name: 'plugin/skills/example/SKILL.md', contents: '# Example\n' },
    ])
    const url = await listen(archive)
    const source = {
      type: 'archive' as const,
      url: `${url}/plugin.zip`,
      sha256: createHash('sha256').update(archive).digest('hex'),
    }

    const resolved = await resolvePluginPackageSource(source)
    try {
      expect(resolved.remote).toBe(true)
      await expect(readFile(path.join(resolved.directory, '.claude-plugin', 'plugin.json'), 'utf8'))
        .resolves.toContain('http-plugin')
    } finally {
      await resolved.cleanup()
    }
  })

  it('rejects traversal through the public plugin archive source entry', async () => {
    const safe = await zip([{ name: 'aa/out.txt', contents: 'escaped' }])
    const archive = replaceAscii(safe, 'aa/out.txt', '../out.txt')
    const url = await listen(archive)

    await expect(resolvePluginPackageSource({
      type: 'archive',
      url: `${url}/malicious.zip`,
      sha256: createHash('sha256').update(archive).digest('hex'),
    })).rejects.toThrow(/ZIP|relative path|越界/i)
  })
})

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
