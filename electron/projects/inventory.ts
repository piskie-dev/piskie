import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { AgentControlState, AgentRunHeader } from '@shared/types/agent-control.js'
import type { ProjectRecord } from '@shared/types/project.js'

interface ExecutionSnapshot {
  workspace?: string
  runName: string
  lastActiveAt: string
}

export interface ProjectInventoryOptions {
  defaultWorkspaceDir: string
  scanHeaders(): AgentRunHeader[]
  getActiveStates(): Iterable<AgentControlState>
}

export interface ProjectInventory {
  list(): Promise<ProjectRecord[]>
}

interface ResolvedWorkspace {
  workspace: string
  available: boolean
}

function timeOf(value: string): number {
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? 0 : time
}

function moreRecent(left: string, right: string): string {
  return timeOf(right) > timeOf(left) ? right : left
}

async function resolveWorkspace(value: string): Promise<ResolvedWorkspace> {
  const absolute = path.resolve(value)
  let workspace = absolute

  try {
    workspace = await fs.realpath(absolute)
  } catch {
    return { workspace, available: false }
  }

  try {
    return { workspace, available: (await fs.stat(workspace)).isDirectory() }
  } catch {
    return { workspace, available: false }
  }
}

function executionSnapshots(options: ProjectInventoryOptions): ExecutionSnapshot[] {
  const byAgentId = new Map<string, ExecutionSnapshot>()

  for (const header of options.scanHeaders()) {
    byAgentId.set(header.agentId, {
      workspace: header.runConfig.workspace,
      runName: header.runConfig.name || header.agentId,
      lastActiveAt: header.lastActiveAt,
    })
  }

  // Live state wins the same way it does in the thread sidebar; history fills absent fields.
  for (const state of options.getActiveStates()) {
    const history = byAgentId.get(state.agentId)
    byAgentId.set(state.agentId, {
      workspace: state.runConfig.workspace || history?.workspace,
      runName: state.runConfig.name || history?.runName || state.agentId,
      lastActiveAt: history
        ? moreRecent(history.lastActiveAt, state.createdAt)
        : state.createdAt,
    })
  }

  return [...byAgentId.values()]
}

export function createProjectInventory(options: ProjectInventoryOptions): ProjectInventory {
  return {
    async list(): Promise<ProjectRecord[]> {
      const defaultWorkspace = await resolveWorkspace(options.defaultWorkspaceDir)
      const resolutionCache = new Map<string, Promise<ResolvedWorkspace>>()
      const resolveCached = (workspace: string): Promise<ResolvedWorkspace> => {
        const cached = resolutionCache.get(workspace)
        if (cached) return cached
        const pending = resolveWorkspace(workspace)
        resolutionCache.set(workspace, pending)
        return pending
      }

      const snapshots = executionSnapshots(options)
      const resolved = await Promise.all(snapshots.map(async (snapshot) => {
        const workspace = snapshot.workspace?.trim()
        if (!workspace) return undefined
        return { snapshot, resolved: await resolveCached(workspace) }
      }))

      const projects = new Map<string, ProjectRecord>()
      for (const item of resolved) {
        if (!item || item.resolved.workspace === defaultWorkspace.workspace) continue

        const { snapshot } = item
        const { workspace, available } = item.resolved
        const current = projects.get(workspace)
        if (current) {
          current.threadCount += 1
          current.lastActiveAt = moreRecent(current.lastActiveAt, snapshot.lastActiveAt)
          current.available ||= available
          if (!current.runNames.includes(snapshot.runName)) current.runNames.push(snapshot.runName)
          continue
        }

        projects.set(workspace, {
          workspace,
          name: path.basename(workspace) || workspace,
          runNames: [snapshot.runName],
          lastActiveAt: snapshot.lastActiveAt,
          threadCount: 1,
          available,
        })
      }

      return [...projects.values()]
        .map((project) => ({ ...project, runNames: project.runNames.sort((a, b) => a.localeCompare(b)) }))
        .sort((left, right) => (
          timeOf(right.lastActiveAt) - timeOf(left.lastActiveAt)
          || left.name.localeCompare(right.name)
          || left.workspace.localeCompare(right.workspace)
        ))
    },
  }
}
