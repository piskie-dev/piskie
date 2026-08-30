import { watch, type FSWatcher } from 'node:fs'

import type { PluginRecord, PluginsFile } from '@shared/types/plugin.js'

import { readPluginsFile } from './store.js'

export interface PluginDiffItem {
  name: string
  kind: 'installed' | 'updated' | 'removed'
  record?: PluginRecord
}

export function diffPlugins(previous: PluginsFile, next: PluginsFile): PluginDiffItem[] {
  const before = new Map(previous.plugins.map((plugin) => [plugin.name, plugin]))
  const after = new Map(next.plugins.map((plugin) => [plugin.name, plugin]))
  const result: PluginDiffItem[] = []
  for (const [name, record] of after) {
    const old = before.get(name)
    if (!old) result.push({ name, kind: 'installed', record })
    else if (JSON.stringify(old) !== JSON.stringify(record)) result.push({ name, kind: 'updated', record })
  }
  for (const name of before.keys()) {
    if (!after.has(name)) result.push({ name, kind: 'removed' })
  }
  return result
}

export interface PluginWatchHandle {
  close(): void
  poke(): Promise<void>
}

export async function watchPluginsFile(options: {
  configRoot: string
  onChange(next: PluginsFile, diff: PluginDiffItem[]): void | Promise<void>
  onError?(error: unknown): void
  debounceMs?: number
}): Promise<PluginWatchHandle> {
  let snapshot = await readPluginsFile(options.configRoot)
  let watcher: FSWatcher | undefined
  let timer: NodeJS.Timeout | undefined
  let chain = Promise.resolve()
  let closed = false

  const check = async (): Promise<void> => {
    if (closed) return
    try {
      const next = await readPluginsFile(options.configRoot)
      if (next.revision === snapshot.revision) return
      const diff = diffPlugins(snapshot, next)
      snapshot = next
      if (diff.length > 0) await options.onChange(next, diff)
    } catch (error) {
      options.onError?.(error)
    }
  }
  const schedule = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      chain = chain.then(check)
    }, options.debounceMs ?? 75)
  }

  try {
    watcher = watch(options.configRoot, (_event, filename) => {
      if (filename && filename !== 'plugins.json') return
      schedule()
    })
    watcher.on('error', (error) => options.onError?.(error))
  } catch (error) {
    options.onError?.(error)
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
