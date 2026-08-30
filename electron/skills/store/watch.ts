import { watch, type FSWatcher } from 'node:fs'

import type { SkillRegistryEntry, SkillRegistryFile } from '@shared/types/skill.js'

import { readRegistry } from './registry.js'

/**
 * app 侧 registry.json 外部写者感知：fs.watch 75ms 去抖 → 修订号门 → onChange。
 * 变更处理串行化（前一次 onChange 未完成时后续触发排队合并）。
 */
export interface RegistryDiffItem {
  name: string
  kind: 'installed' | 'uninstalled' | 'enabled' | 'disabled' | 'updated'
  entry?: SkillRegistryEntry
}

export function diffRegistries(prev: SkillRegistryFile, next: SkillRegistryFile): RegistryDiffItem[] {
  const out: RegistryDiffItem[] = []
  for (const [name, entry] of Object.entries(next.skills)) {
    const before = prev.skills[name]
    if (!before) {
      out.push({ name, kind: 'installed', entry })
    } else if (before.enabled !== entry.enabled) {
      out.push({ name, kind: entry.enabled ? 'enabled' : 'disabled', entry })
    } else if (JSON.stringify(before) !== JSON.stringify(entry)) {
      out.push({ name, kind: 'updated', entry })
    }
  }
  for (const name of Object.keys(prev.skills)) {
    if (!next.skills[name]) out.push({ name, kind: 'uninstalled' })
  }
  return out
}

export interface RegistryWatchOptions {
  skillsRoot: string
  onChange(next: SkillRegistryFile, diff: RegistryDiffItem[]): void | Promise<void>
  onError?(error: unknown): void
  debounceMs?: number
}

export interface RegistryWatchHandle {
  close(): void
  /** 测试与直连补发用：立即执行一轮检查（仍走修订号门） */
  poke(): Promise<void>
}

const DEFAULT_DEBOUNCE_MS = 75

export async function watchSkillsRegistry(options: RegistryWatchOptions): Promise<RegistryWatchHandle> {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  let snapshot = await readRegistry(options.skillsRoot)
  let timer: NodeJS.Timeout | null = null
  let chain: Promise<void> = Promise.resolve()
  let closed = false

  async function check(): Promise<void> {
    if (closed) return
    let next: SkillRegistryFile
    try {
      next = await readRegistry(options.skillsRoot)
    } catch (err) {
      options.onError?.(err)
      return
    }
    if (next.revision === snapshot.revision) return
    const diff = diffRegistries(snapshot, next)
    snapshot = next
    if (diff.length === 0) return
    try {
      await options.onChange(next, diff)
    } catch (err) {
      options.onError?.(err)
    }
  }

  function schedule(): void {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      chain = chain.then(check)
    }, debounceMs)
  }

  let watcher: FSWatcher | null = null
  try {
    watcher = watch(options.skillsRoot, (_event, filename) => {
      // 原子替换产生 rename 事件；锁文件与临时文件同目录，按文件名过滤
      if (filename && filename !== 'registry.json') return
      schedule()
    })
    watcher.on('error', (err) => options.onError?.(err))
  } catch (err) {
    options.onError?.(err)
  }

  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      watcher?.close()
    },
    async poke() {
      chain = chain.then(check)
      await chain
    },
  }
}
