import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mergeSidecar, readSidecar, SIDECAR_FILE, writeSidecar } from '../sidecar'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sidecar-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sidecar', () => {
  it('写入后可读回，文件为格式化 JSON', async () => {
    await writeSidecar(dir, { installedAt: '2026-08-07T00:00:00Z', type: 'local', autoCompletedType: true })
    const meta = await readSidecar(dir)
    expect(meta).toEqual({ installedAt: '2026-08-07T00:00:00Z', type: 'local', autoCompletedType: true })
    const raw = await readFile(path.join(dir, SIDECAR_FILE), 'utf8')
    expect(raw).toContain('\n')
  })

  it('缺失 → null', async () => {
    expect(await readSidecar(dir)).toBeNull()
  })

  it('损坏 JSON / 顶层非对象 → null（按缺失处理，不抛）', async () => {
    await writeFile(path.join(dir, SIDECAR_FILE), '{broken', 'utf8')
    expect(await readSidecar(dir)).toBeNull()
    await writeFile(path.join(dir, SIDECAR_FILE), '[1,2]', 'utf8')
    expect(await readSidecar(dir)).toBeNull()
  })

  it('mergeSidecar 只覆盖 patch 键，保留既有字段', async () => {
    await writeSidecar(dir, {
      installedAt: 'T0',
      skillType: 'guide-only',
      runtimeSetup: { pythonVenv: true },
    })
    const next = await mergeSidecar(dir, { skillType: 'executable', hasSettings: true })
    expect(next).toEqual({
      installedAt: 'T0',
      skillType: 'executable',
      hasSettings: true,
      runtimeSetup: { pythonVenv: true },
    })
    expect(await readSidecar(dir)).toEqual(next)
  })

  it('mergeSidecar 在无 sidecar 时等价于写入', async () => {
    const next = await mergeSidecar(dir, { source: '/tmp/from', sourceType: 'local' })
    expect(next).toEqual({ source: '/tmp/from', sourceType: 'local' })
  })
})
