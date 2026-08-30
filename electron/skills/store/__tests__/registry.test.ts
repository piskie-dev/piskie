import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  emptyRegistry,
  readRegistry,
  RevisionConflictError,
  updateRegistry,
} from '../registry'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'skill-registry-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function entry(name: string) {
  return { name, type: 'local', path: `/skills/${name}`, enabled: true }
}

describe('readRegistry', () => {
  it('文件缺失 → 空 registry（revision 0）', async () => {
    expect(await readRegistry(root)).toEqual(emptyRegistry())
  })

  it('旧形状（无 revision）升级为 revision 0，条目保留', async () => {
    await writeFile(
      path.join(root, 'registry.json'),
      JSON.stringify({ version: '1.0', skills: { a: entry('a') } }),
      'utf8',
    )
    const reg = await readRegistry(root)
    expect(reg.revision).toBe(0)
    expect(reg.skills.a.name).toBe('a')
  })
})

describe('updateRegistry', () => {
  it('每次写 revision+1，落盘为格式化 JSON', async () => {
    const r1 = await updateRegistry(root, (draft) => {
      draft.skills.a = entry('a')
    })
    expect(r1.revision).toBe(1)
    const r2 = await updateRegistry(root, (draft) => {
      draft.skills.b = entry('b')
    })
    expect(r2.revision).toBe(2)
    const onDisk = JSON.parse(await readFile(path.join(root, 'registry.json'), 'utf8'))
    expect(onDisk.revision).toBe(2)
    expect(Object.keys(onDisk.skills)).toEqual(['a', 'b'])
  })

  it('显式 CAS：expectedRevision 不匹配 → RevisionConflictError，盘上不变', async () => {
    await updateRegistry(root, (draft) => {
      draft.skills.a = entry('a')
    })
    await expect(
      updateRegistry(
        root,
        (draft) => {
          draft.skills.b = entry('b')
        },
        { expectedRevision: 0 },
      ),
    ).rejects.toThrow(RevisionConflictError)
    const reg = await readRegistry(root)
    expect(reg.revision).toBe(1)
    expect(reg.skills.b).toBeUndefined()
  })

  it('CAS 双写者竞争：并发写全部落盘且 revision 严格递增无丢失', async () => {
    const writers = Array.from({ length: 8 }, (_, i) =>
      updateRegistry(root, (draft) => {
        draft.skills[`s${i}`] = entry(`s${i}`)
      }),
    )
    const results = await Promise.all(writers)
    const revisions = results.map((r) => r.revision).sort((a, b) => a - b)
    expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    const final = await readRegistry(root)
    expect(final.revision).toBe(8)
    expect(Object.keys(final.skills)).toHaveLength(8)
  })

  it('mutate 抛出时不落盘、锁被释放', async () => {
    await expect(
      updateRegistry(root, () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect((await readRegistry(root)).revision).toBe(0)
    const ok = await updateRegistry(root, (draft) => {
      draft.skills.a = entry('a')
    })
    expect(ok.revision).toBe(1)
  })

  it('陈旧锁被抢占（死写者遗留不阻塞后续写入）', async () => {
    const lockPath = path.join(root, 'registry.json.lock')
    await writeFile(lockPath, JSON.stringify({ pid: 99999, at: 0 }), 'utf8')
    const past = new Date(Date.now() - 60_000)
    const { utimes } = await import('node:fs/promises')
    await utimes(lockPath, past, past)
    const result = await updateRegistry(root, (draft) => {
      draft.skills.a = entry('a')
    })
    expect(result.revision).toBe(1)
  })
})
