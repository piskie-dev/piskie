import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readPluginsFile, updatePluginsFile } from '../store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('plugins.json store', () => {
  it('serializes concurrent writers and increments revision', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-plugin-store-'))
    roots.push(root)
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      updatePluginsFile(root, async (draft) => {
        await Promise.resolve()
        draft.plugins.push({
          name: `plugin-${index}`,
          source: `/source/${index}`,
          scope: 'user',
          path: `/plugin/${index}`,
          installedAt: new Date(0).toISOString(),
          members: { skills: [], mcpServers: [] },
        })
      }),
    ))
    const stored = await readPluginsFile(root)
    expect(stored.revision).toBe(8)
    expect(stored.plugins).toHaveLength(8)
  })
})
