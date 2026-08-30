import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SkillRegistryFile } from '@shared/types/skill.js'

import { emptyRegistry, updateRegistry } from '../registry.js'
import { diffRegistries, watchSkillsRegistry, type RegistryDiffItem } from '../watch.js'

describe('diffRegistries', () => {
  const base = (skills: SkillRegistryFile['skills'], revision = 1): SkillRegistryFile => ({
    version: '1.0',
    revision,
    skills,
  })

  const entry = (name: string, enabled = true) => ({
    name,
    type: 'local',
    path: `/skills/${name}`,
    enabled,
    installedAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
  })

  it('识别安装/卸载/启停/更新四类变更', () => {
    const prev = base({
      a: entry('a'),
      b: entry('b', true),
      c: entry('c'),
      d: entry('d'),
    })
    const next = base(
      {
        b: entry('b', false),
        c: { ...entry('c'), version: '2.0' },
        d: entry('d'),
        e: entry('e'),
      },
      2,
    )
    const diff = diffRegistries(prev, next)
    const kinds = Object.fromEntries(diff.map((d) => [d.name, d.kind]))
    expect(kinds).toEqual({
      a: 'uninstalled',
      b: 'disabled',
      c: 'updated',
      e: 'installed',
    })
  })

  it('无变更时 diff 为空', () => {
    const prev = base({ a: entry('a') })
    expect(diffRegistries(prev, { ...prev })).toEqual([])
  })
})

describe('watchSkillsRegistry', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'piskie-watch-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('registry 写入经去抖后触发一次 onChange，diff 正确', async () => {
    const events: RegistryDiffItem[][] = []
    const handle = await watchSkillsRegistry({
      skillsRoot: root,
      debounceMs: 20,
      onChange: (_next, diff) => {
        events.push(diff)
      },
    })
    try {
      await updateRegistry(root, (registry) => {
        registry.skills['demo'] = {
          name: 'demo',
          type: 'local',
          path: path.join(root, 'local', 'demo'),
          enabled: true,
          installedAt: '2026-08-07T00:00:00.000Z',
          updatedAt: '2026-08-07T00:00:00.000Z',
        }
      })
      await waitFor(() => events.length >= 1)
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual([
        expect.objectContaining({ name: 'demo', kind: 'installed' }),
      ])
    } finally {
      handle.close()
    }
  })

  it('连续多次写入在去抖窗口内合并为一次 onChange', async () => {
    let calls = 0
    const handle = await watchSkillsRegistry({
      skillsRoot: root,
      debounceMs: 60,
      onChange: () => {
        calls += 1
      },
    })
    try {
      for (let i = 0; i < 3; i++) {
        await updateRegistry(root, (registry) => {
          registry.skills[`s${i}`] = {
            name: `s${i}`,
            type: 'local',
            path: path.join(root, 'local', `s${i}`),
            enabled: true,
            installedAt: '2026-08-07T00:00:00.000Z',
            updatedAt: '2026-08-07T00:00:00.000Z',
          }
        })
      }
      await waitFor(() => calls >= 1)
      // 再等一个去抖窗口确认没有第二次触发
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(calls).toBe(1)
    } finally {
      handle.close()
    }
  })

  it('revision 未变化时 poke 不触发 onChange', async () => {
    let calls = 0
    const handle = await watchSkillsRegistry({
      skillsRoot: root,
      debounceMs: 20,
      onChange: () => {
        calls += 1
      },
    })
    try {
      await handle.poke()
      await handle.poke()
      expect(calls).toBe(0)
    } finally {
      handle.close()
    }
  })

  it('初始无 registry 文件也能启动并感知首次写入', async () => {
    const empty = emptyRegistry()
    expect(empty.revision).toBe(0)

    const events: RegistryDiffItem[][] = []
    const handle = await watchSkillsRegistry({
      skillsRoot: path.join(root, 'fresh'),
      debounceMs: 20,
      onChange: (_next, diff) => {
        events.push(diff)
      },
    })
    try {
      await updateRegistry(path.join(root, 'fresh'), (registry) => {
        registry.skills['first'] = {
          name: 'first',
          type: 'browser',
          path: path.join(root, 'fresh', 'browser', 'first'),
          enabled: true,
          installedAt: '2026-08-07T00:00:00.000Z',
          updatedAt: '2026-08-07T00:00:00.000Z',
        }
      })
      // 目录在 watch 启动时不存在 → fs.watch 可能未挂上；poke 是兜底路径
      await handle.poke()
      await waitFor(() => events.length >= 1)
      expect(events[0]?.[0]?.name).toBe('first')
    } finally {
      handle.close()
    }
  })
})

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
