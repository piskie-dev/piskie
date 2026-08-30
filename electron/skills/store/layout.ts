import { promises as fs } from 'node:fs'
import path from 'node:path'

import { getSkillsDirByType, getSkillsRootDir } from '@electron/piskiepilot/paths.js'
import type { SkillScope, SkillType } from '@shared/types/skill.js'

/**
 * 三层技能根的路径解析与项目级浅扫描。
 *
 * | 层     | 位置                                        | 形态          | 记账 |
 * | 内置   | 随 app 分发                                  | 知识型        | 无   |
 * | 全局   | {pilotRoot}/skills/{type}/{name}            | 知识型+可执行 | registry.json |
 * | 项目级 | {workspace}/.piskie/skills/{name} 及插件成员 | 仅知识型      | 无（发现即用） |
 *
 * 路径消费方必须 lazy 取值（getPilotRoot 注入前求值会冻结 fallback 根）。
 */
export const PROJECT_STATE_DIR = '.piskie'

export function globalSkillsRoot(): string {
  return getSkillsRootDir()
}

export function globalSkillTypeDir(type: SkillType): string {
  return getSkillsDirByType(type)
}

export function globalSkillDir(type: SkillType, name: string): string {
  return path.join(getSkillsDirByType(type), name)
}

export function projectSkillsRoot(workspace: string): string {
  return path.join(workspace, PROJECT_STATE_DIR, 'skills')
}

export function projectPluginsRoot(workspace: string): string {
  return path.join(workspace, PROJECT_STATE_DIR, 'plugins')
}

/** Readers and writers resolve through the same current project-state root. */
export async function projectStatePathsForRead(
  workspace: string,
  ...segments: string[]
): Promise<string[]> {
  return [path.join(workspace, PROJECT_STATE_DIR, ...segments)]
}

export async function projectStatePathForRead(
  workspace: string,
  ...segments: string[]
): Promise<string> {
  return (await projectStatePathsForRead(workspace, ...segments)).at(-1)!
}

export function projectSkillsRootsForRead(workspace: string): Promise<string[]> {
  return projectStatePathsForRead(workspace, 'skills')
}

export function projectPluginsRootsForRead(workspace: string): Promise<string[]> {
  return projectStatePathsForRead(workspace, 'plugins')
}

/**
 * 项目层激活判据：判据跟路径走，不跟字段走。
 * 解析后的 workspace realpath 等于缺省 workspace 路径（{userData}/workspace/，
 * 被所有缺省 AgentRun 共享）时不激活——显式配成缺省路径同样不激活。
 */
export async function isProjectLayerActive(
  workspace: string | undefined,
  defaultWorkspaceDir: string,
): Promise<boolean> {
  if (!workspace || workspace.trim() === '') return false
  const [resolved, resolvedDefault] = await Promise.all([
    realpathOrNormalize(workspace),
    realpathOrNormalize(defaultWorkspaceDir),
  ])
  return resolved !== resolvedDefault
}

async function realpathOrNormalize(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return path.resolve(p)
  }
}

export interface ProjectSkillEntry {
  name: string
  dir: string
  scope: Extract<SkillScope, 'project'>
  /** 项目插件成员时为插件目录名 */
  plugin?: string
}

/**
 * 项目级浅扫描：{workspace}/.piskie/skills/<name>/SKILL.md 与
 * {workspace}/.piskie/plugins/<plugin>/skills/<name>/SKILL.md。
 * 只认目录 + SKILL.md 存在（codex DirectChildren 模式），不读内容。
 */
export async function scanProjectSkills(workspace: string): Promise<ProjectSkillEntry[]> {
  const byName = new Map<string, ProjectSkillEntry>()

  for (const stateRoot of await projectStatePathsForRead(workspace)) {
    for (const dir of await listSkillDirs(path.join(stateRoot, 'skills'))) {
      const name = path.basename(dir)
      byName.set(name, { name, dir, scope: 'project' })
    }
    for (const pluginDir of await listChildDirs(path.join(stateRoot, 'plugins'))) {
      for (const dir of await listSkillDirs(path.join(pluginDir, 'skills'))) {
        const name = path.basename(dir)
        byName.set(name, {
          name,
          dir,
          scope: 'project',
          plugin: path.basename(pluginDir),
        })
      }
    }
  }

  return [...byName.values()]
}

async function listChildDirs(parent: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(parent, e.name))
  } catch {
    return []
  }
}

async function listSkillDirs(parent: string): Promise<string[]> {
  const dirs = await listChildDirs(parent)
  const withManifest = await Promise.all(
    dirs.map(async (dir) => {
      try {
        await fs.access(path.join(dir, 'SKILL.md'))
        return dir
      } catch {
        return null
      }
    }),
  )
  return withManifest.filter((d): d is string => d !== null)
}
