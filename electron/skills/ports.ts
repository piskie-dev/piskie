import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { SkillRegistryEntry, SkillScope, SkillSidecarMeta } from '@shared/types/skill.js'

import { parseSkillManifest } from './manifest/parse.js'
import { readSidecar } from './manifest/sidecar.js'
import {
  installSkill,
  removeSkill,
  setSkillEnabled,
  SkillPipelineError,
  type InstallPublishHooks,
  type InstallSkillOutcome,
  type InstallSkillRequest,
} from './install/pipeline.js'
import { globalSkillsRoot, scanProjectSkills } from './store/layout.js'
import { readRegistry } from './store/registry.js'

/**
 * SkillsPort：技能管理面唯一应用端口。
 * IPC handler、CLI、Browser Skill 发布和插件安装事务共用。
 */
export interface SkillListItem {
  name: string
  description: string
  type?: string
  version?: string
  scope: SkillScope
  enabled: boolean
  executionType: 'knowledge' | 'executable'
  path: string
  installedAt?: string
  hasSettings?: boolean
  /** 插件成员时为插件名 */
  plugin?: string
  /** 安装来源；内置项为 builtin，项目发现项缺省为盘上路径。 */
  source?: string
}

export interface SkillDetail extends SkillListItem {
  body?: string
  files: string[]
  functions?: Array<Record<string, string>>
  sidecar?: SkillSidecarMeta | null
  source?: string
  warnings?: string[]
}

export interface SkillListFilter {
  type?: string
  scope?: SkillScope | 'all'
  /** scope=project / all 时的项目 workspace 列表 */
  workspaces?: string[]
}

/** app 才有的运行时供给；CLI 进程不传 */
export interface SkillsRuntimeSupply {
  /** 内置技能描述（随 app 分发；CLI 视角不可枚举） */
  listBuiltin?(): Array<{ name: string; description: string; type?: string; path: string }>
  /** 已加载模块的函数签名渲染（可执行技能 show 用） */
  getFunctionSignatures?(name: string): Array<Record<string, string>> | undefined
  /** 当前已加载版本的文档/资源根；executable Skill 通常位于内容寻址 build。 */
  getResourceRoot?(name: string): string | undefined
  /** 内存发布段挂钩（两段连跑） */
  installHooks?: InstallPublishHooks
  /** registry 变更后的统一投影通知（watch 不在场时的直连补发） */
  onChanged?(): void | Promise<void>
}

export interface SkillsPortOptions {
  defaultWorkspaceDir?: string
  installedBy?: string
  runtime?: SkillsRuntimeSupply
}

export interface SkillsPort {
  list(filter?: SkillListFilter): Promise<SkillListItem[]>
  show(name: string, opts?: { scope?: SkillScope; workspace?: string }): Promise<SkillDetail>
  install(request: InstallSkillRequest): Promise<InstallSkillOutcome>
  remove(name: string, opts?: { scope?: 'user' | 'project'; workspace?: string }): Promise<{ name: string; path: string }>
  enable(name: string): Promise<void>
  disable(name: string): Promise<void>
  search(query: string, opts?: { workspaces?: string[] }): Promise<SkillListItem[]>
}

export function createSkillsPort(options: SkillsPortOptions = {}): SkillsPort {
  const { runtime } = options

  async function collect(filter: SkillListFilter = {}): Promise<SkillListItem[]> {
    const scope = filter.scope ?? 'all'
    const byName = new Map<string, SkillListItem>()

    // 遮蔽顺序：内置 < 全局 < 项目级（后写覆盖）
    if ((scope === 'all' || scope === 'builtin') && runtime?.listBuiltin) {
      for (const b of runtime.listBuiltin()) {
        byName.set(b.name, {
          name: b.name,
          description: b.description,
          type: b.type,
          scope: 'builtin',
          enabled: true,
          executionType: 'knowledge',
          path: b.path,
          source: 'builtin',
        })
      }
    }

    if (scope === 'all' || scope === 'user' || scope === 'builtin') {
      const registry = await readRegistry(globalSkillsRoot())
      for (const entry of Object.values(registry.skills)) {
        if (scope === 'builtin') break
        byName.set(entry.name, registryItem(entry))
      }
    }

    if ((scope === 'all' || scope === 'project') && filter.workspaces) {
      for (const workspace of filter.workspaces) {
        for (const found of await scanProjectSkills(workspace)) {
          const summary = await readManifestSummary(found.dir)
          const sidecar = await readSidecar(found.dir)
          byName.set(found.name, {
            name: found.name,
            description: summary?.description ?? '',
            type: summary?.type,
            version: summary?.version,
            scope: 'project',
            enabled: true,
            executionType: 'knowledge',
            path: found.dir,
            plugin: found.plugin,
            source: sidecar?.source ?? found.dir,
          })
        }
      }
    }

    let items = [...byName.values()]
    if (scope !== 'all') items = items.filter((i) => i.scope === scope)
    if (filter.type) items = items.filter((i) => i.type === filter.type)
    return items.sort((a, b) => a.name.localeCompare(b.name))
  }

  return {
    list: (filter) => collect(filter),

    async show(name, opts = {}) {
      const candidates = await collect({
        scope: opts.scope ?? 'all',
        workspaces: opts.workspace ? [opts.workspace] : undefined,
      })
      const item = candidates.find((c) => c.name === name)
      if (!item) throw new SkillPipelineError('SKILL_NOT_FOUND', `技能不存在：${name}`)

      const detail: SkillDetail = { ...item, files: [] }
      const resourceRoot = runtime?.getResourceRoot?.(name)
        ?? await resolveInstalledResourceRoot(item)
      try {
        const raw = await fs.readFile(path.join(resourceRoot, 'SKILL.md'), 'utf8')
        const parsed = parseSkillManifest(raw)
        detail.body = parsed.body
      } catch {
        // 可执行技能安装目录可能只有 current 指针；正文经加载面读取
      }
      detail.files = await listFiles(resourceRoot)
      detail.sidecar = await readSidecar(item.path)
      detail.source = detail.sidecar?.source
      const signatures = runtime?.getFunctionSignatures?.(name)
      if (signatures) detail.functions = signatures
      return detail
    },

    async install(request) {
      const outcome = await installSkill(
        {
          defaultWorkspaceDir: options.defaultWorkspaceDir,
          installedBy: options.installedBy,
          ...request,
        },
        runtime?.installHooks ?? {},
      )
      await runtime?.onChanged?.()
      return outcome
    },

    async remove(name, opts = {}) {
      const result = await removeSkill({ name, scope: opts.scope, workspace: opts.workspace })
      await runtime?.onChanged?.()
      return result
    },

    async enable(name) {
      await setSkillEnabled(name, true)
      await runtime?.onChanged?.()
    },

    async disable(name) {
      await setSkillEnabled(name, false)
      await runtime?.onChanged?.()
    },

    async search(query, opts = {}) {
      const items = await collect({ scope: 'all', workspaces: opts.workspaces })
      const needle = query.trim().toLowerCase()
      if (!needle) return []
      return items
        .map((item) => ({ item, score: matchScore(item, needle) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((s) => s.item)
    },
  }
}

function registryItem(entry: SkillRegistryEntry): SkillListItem {
  return {
    name: entry.name,
    description: entry.description ?? '',
    type: entry.type,
    version: entry.version,
    scope: 'user',
    enabled: entry.enabled,
    executionType: entry.executionType === 'executable' ? 'executable' : 'knowledge',
    path: entry.path,
    installedAt: entry.installedAt,
    hasSettings: entry.hasSettings,
    plugin: entry.installedFrom?.plugin,
    source: entry.source,
  }
}

function matchScore(item: SkillListItem, needle: string): number {
  const name = item.name.toLowerCase()
  const description = item.description.toLowerCase()
  if (name === needle) return 100
  if (name.includes(needle)) return 60
  if (description.includes(needle)) return 30
  return 0
}

async function readManifestSummary(
  dir: string,
): Promise<{ description?: string; type?: string; version?: string } | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')
    const parsed = parseSkillManifest(raw)
    return parsed.manifest
      ? {
          description: parsed.manifest.description,
          type: parsed.manifest.type,
          version: parsed.manifest.version,
        }
      : null
  } catch {
    return null
  }
}

async function listFiles(dir: string, depth = 3, prefix = ''): Promise<string[]> {
  if (depth <= 0) return []
  const out: string[] = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.venv' || entry.name === '__pycache__') continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await listFiles(path.join(dir, entry.name), depth - 1, rel)))
    } else {
      out.push(rel)
    }
  }
  return out.slice(0, 200)
}

const EXECUTABLE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const EXECUTABLE_BUILD_HASH = /^[a-f0-9]{64}$/u

/** Resolve the current executable content for CLI callers that have no live Runtime. */
async function resolveInstalledResourceRoot(item: SkillListItem): Promise<string> {
  if (
    item.scope !== 'user'
    || item.executionType !== 'executable'
    || !EXECUTABLE_SKILL_NAME.test(item.name)
  ) {
    return item.path
  }

  try {
    const hash = (await fs.readFile(path.join(item.path, 'current'), 'utf8')).trim()
    if (!EXECUTABLE_BUILD_HASH.test(hash)) return item.path
    return path.join(globalSkillsRoot(), '.build', item.name, hash, 'module')
  } catch {
    return item.path
  }
}
