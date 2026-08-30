import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SUPPORTED_PLUGIN_SCHEMAS } from '../../plugins/manifest.js'
import { runCli } from '../main.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function run(args: string[], root: string) {
  let stdout = ''
  let stderr = ''
  const code = await runCli([...args, '--root', root], {
    io: {
      stdin: async () => '',
      stdout: (value) => { stdout += value },
      stderr: (value) => { stderr += value },
    },
  })
  return {
    code,
    stdout: stdout ? JSON.parse(stdout) as Record<string, unknown> : undefined,
    stderr: stderr ? JSON.parse(stderr) as Record<string, unknown> : undefined,
  }
}

async function makePlugin(root: string): Promise<string> {
  const source = path.join(root, 'source', 'docs-kit')
  await mkdir(path.join(source, 'skills', 'docs-reader'), { recursive: true })
  await writeFile(path.join(source, 'plugin.json'), JSON.stringify({
    $schema: SUPPORTED_PLUGIN_SCHEMAS[0],
    name: 'docs-kit',
    version: '1.0.0',
  }), 'utf8')
  await writeFile(
    path.join(source, 'skills', 'docs-reader', 'SKILL.md'),
    '---\nname: docs-reader\ndescription: Read project docs\n---\n\n# Docs\n',
    'utf8',
  )
  return source
}

describe('piskie plugin command group', () => {
  it('installs, lists, shows and removes a plugin through stable envelopes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-plugin-cli-'))
    roots.push(root)
    const source = await makePlugin(root)

    expect(await run(['plugin', 'install', source, '--json'], root)).toMatchObject({
      code: 0,
      stdout: { ok: true, command: 'plugin.install', data: { name: 'docs-kit' } },
    })
    expect(await run(['plugin', 'list', '--json'], root)).toMatchObject({
      code: 0,
      stdout: { data: [{ name: 'docs-kit', members: { skills: [{ name: 'docs-reader' }] } }] },
    })
    expect(await run(['plugin', 'show', 'docs-kit', '--json'], root)).toMatchObject({
      code: 0,
      stdout: { data: { manifest: { name: 'docs-kit' } } },
    })
    expect(await run(['plugin', 'remove', 'docs-kit', '--json'], root)).toMatchObject({
      code: 0,
      stdout: { data: { name: 'docs-kit', purged: false } },
    })
  })
})
