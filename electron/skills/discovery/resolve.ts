import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { SkillListFilter, SkillListItem } from '../ports.js'
import { globalSkillsRoot, isProjectLayerActive } from '../store/layout.js'

export interface SkillSelectionPort {
  listManagedSkills(filter?: SkillListFilter): Promise<SkillListItem[]>
}

export interface SkillWorkspaceOptions {
  workspace?: string
  defaultWorkspaceDir?: string
}

/** Enumerate the same project layer for inventory, teaching and search. */
export async function listAvailableSkills(
  port: SkillSelectionPort,
  options: SkillWorkspaceOptions = {},
): Promise<SkillListItem[]> {
  const projectActive = options.workspace && options.defaultWorkspaceDir
    ? await isProjectLayerActive(options.workspace, options.defaultWorkspaceDir)
    : false
  return port.listManagedSkills({
    scope: 'all',
    workspaces: projectActive && options.workspace ? [options.workspace] : undefined,
  })
}

export async function resolveAvailableSkill(
  port: SkillSelectionPort,
  name: string,
  options: SkillWorkspaceOptions,
): Promise<SkillListItem | undefined> {
  return (await listAvailableSkills(port, options)).find((item) => item.name === name)
}

const EXECUTABLE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const EXECUTABLE_BUILD_HASH = /^[a-f0-9]{64}$/u

/** Resolve resources from the selected entry, including CLI executable builds. */
export async function resolveSkillResourceRoot(
  item: SkillListItem,
  getRuntimeRoot?: (name: string) => string | undefined,
): Promise<string> {
  if (item.scope === 'project') return item.path
  const runtimeRoot = getRuntimeRoot?.(item.name)
  if (runtimeRoot) return runtimeRoot
  if (item.scope !== 'user' || item.executionType !== 'executable'
    || !EXECUTABLE_SKILL_NAME.test(item.name)) return item.path

  try {
    const hash = (await fs.readFile(path.join(item.path, 'current'), 'utf8')).trim()
    if (!EXECUTABLE_BUILD_HASH.test(hash)) return item.path
    return path.join(globalSkillsRoot(), '.build', item.name, hash, 'module')
  } catch {
    return item.path
  }
}
