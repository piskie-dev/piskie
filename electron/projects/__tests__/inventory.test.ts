import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentControlState, AgentRunHeader } from '@shared/types/agent-control.js'

import { createProjectInventory } from '../inventory.js'

let root: string
let defaultWorkspace: string
let headers: AgentRunHeader[]
let activeStates: AgentControlState[]

beforeEach(async () => {
  // macOS 的 os.tmpdir() 返回 /var/... （指向 /private/var/... 的符号链接），
  // 而被测实现按契约做 realpath 规范化（inventory.ts / mcp ports 的 workspace 都是 realpath）。
  // 夹具根若不先规范化，断言就会拿 /var 去比实现产出的 /private/var，在 macOS 上必红。
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piskie-project-inventory-')))
  defaultWorkspace = path.join(root, 'default-workspace')
  await mkdir(defaultWorkspace)
  headers = []
  activeStates = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function runConfig(name: string, workspace?: string) {
  return { name, description: '', promptTemplate: '', workspace }
}

function header(
  agentId: string,
  workspace: string | undefined,
  lastActiveAt: string,
  name = agentId,
): AgentRunHeader {
  return {
    agentId,
    agentSpec: 'director',
    modeId: 'normal',
    runConfig: runConfig(name, workspace),
    createdAt: lastActiveAt,
    lastActiveAt,
    currentModel: 'test::model',
    approvalMode: 'confirm',
    childAgents: [],
  }
}

function active(
  agentId: string,
  workspace: string | undefined,
  createdAt: string,
  name = agentId,
): AgentControlState {
  return {
    agentId,
    phase: 'waiting',
    currentModel: 'test::model',
    reasoningOverride: { kind: 'provider-default' },
    approvalMode: 'confirm',
    modeId: 'plan',
    conversationLength: 0,
    children: [],
    agentSpec: 'director',
    runConfig: runConfig(name, workspace),
    createdAt,
  }
}

function inventory() {
  return createProjectInventory({
    defaultWorkspaceDir: defaultWorkspace,
    scanHeaders: () => headers,
    getActiveStates: () => activeStates,
  })
}

describe('ProjectInventory', () => {
  it('discovers Projects from history and live executions, ordered by recent activity', async () => {
    const historyProject = path.join(root, 'history-project')
    const liveProject = path.join(root, 'live-project')
    await Promise.all([mkdir(historyProject), mkdir(liveProject)])
    headers = [header('history', historyProject, '2026-08-01T00:00:00.000Z', 'History Flow')]
    activeStates = [active('live', liveProject, '2026-08-02T00:00:00.000Z', 'Live Flow')]

    expect(await inventory().list()).toEqual([
      {
        workspace: liveProject,
        name: 'live-project',
        runNames: ['Live Flow'],
        lastActiveAt: '2026-08-02T00:00:00.000Z',
        threadCount: 1,
        available: true,
      },
      {
        workspace: historyProject,
        name: 'history-project',
        runNames: ['History Flow'],
        lastActiveAt: '2026-08-01T00:00:00.000Z',
        threadCount: 1,
        available: true,
      },
    ])
  })

  it('keeps independent AgentRuns even when they have the same display name', async () => {
    const oldProject = path.join(root, 'old-project')
    const currentProject = path.join(root, 'current-project')
    await Promise.all([mkdir(oldProject), mkdir(currentProject)])
    headers = [
      header('run-old', oldProject, '2026-08-01T00:00:00.000Z', 'Shared task'),
      header('run-current', currentProject, '2026-08-02T00:00:00.000Z', 'Shared task'),
    ]

    const projects = await inventory().list()
    expect(projects).toHaveLength(2)
    expect(projects[0]?.workspace).toBe(currentProject)
    expect(projects[1]?.workspace).toBe(oldProject)
  })

  it('lets live execution workspace win and uses history only to fill an absent live workspace', async () => {
    const historyProject = path.join(root, 'history-project')
    const liveProject = path.join(root, 'live-project')
    await Promise.all([mkdir(historyProject), mkdir(liveProject)])
    headers = [
      header('moved-flow', historyProject, '2026-08-03T00:00:00.000Z', 'Moved'),
      header('fallback-flow', historyProject, '2026-08-01T00:00:00.000Z', 'Fallback'),
    ]
    activeStates = [
      active('moved-flow', liveProject, '2026-08-02T00:00:00.000Z', 'Moved'),
      active('fallback-flow', undefined, '2026-08-04T00:00:00.000Z', 'Fallback'),
    ]

    const projects = await inventory().list()
    expect(projects.map((project) => project.workspace)).toEqual([historyProject, liveProject])
    expect(projects[0]).toMatchObject({
      runNames: ['Fallback'],
      lastActiveAt: '2026-08-04T00:00:00.000Z',
    })
    expect(projects[1]).toMatchObject({
      runNames: ['Moved'],
      lastActiveAt: '2026-08-03T00:00:00.000Z',
    })
  })

  it('canonicalizes equivalent paths, groups threads once, and excludes the default workspace', async () => {
    const project = path.join(root, 'project')
    await mkdir(project)
    headers = [
      header('flow-b', path.join(project, '..', 'project'), '2026-08-01T00:00:00.000Z', 'B'),
      header('flow-a', project, '2026-08-02T00:00:00.000Z', 'A'),
      header('default', defaultWorkspace, '2026-08-03T00:00:00.000Z', 'Default'),
    ]

    expect(await inventory().list()).toEqual([{
      workspace: project,
      name: 'project',
      runNames: ['A', 'B'],
      lastActiveAt: '2026-08-02T00:00:00.000Z',
      threadCount: 2,
      available: true,
    }])
  })

  it('retains a missing historical Project but marks it unavailable', async () => {
    const missingProject = path.join(root, 'removed-project')
    headers = [header('removed', missingProject, '2026-08-01T00:00:00.000Z', 'Removed')]

    expect(await inventory().list()).toEqual([{
      workspace: missingProject,
      name: 'removed-project',
      runNames: ['Removed'],
      lastActiveAt: '2026-08-01T00:00:00.000Z',
      threadCount: 1,
      available: false,
    }])
  })

  it('returns no Projects when there are no execution records', async () => {
    expect(await inventory().list()).toEqual([])
  })
})
