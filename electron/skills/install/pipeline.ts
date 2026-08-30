import { createUuid } from '@shared/utils/identifiers.js';

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertDefinedSkill } from '@electron/piskiepilot/core/skill/define.js'
import { CORE_SKILLS } from '@electron/piskiepilot/core/skill/loader.js'
import { ExecutableSkillStore } from '../executable/store.js'
import type { SkillRegistryEntry, SkillType } from '@shared/types/skill.js'

import { writeSidecar } from '../manifest/sidecar.js'
import {
  globalSkillDir,
  globalSkillsRoot,
  globalSkillTypeDir,
  isProjectLayerActive,
  projectSkillsRoot,
  projectSkillsRootsForRead,
} from '../store/layout.js'
import {
  readRegistry,
  RegistryLockTimeoutError,
  RevisionConflictError,
  updateRegistry,
  type UpdateOptions,
} from '../store/registry.js'
import { resolveSource, SourceResolveError } from './sources.js'
import { validateSkillDir, type SkillValidationIssue } from './validate.js'

/**
 * 安装管线：来源(resolve) → 校验(validate) → 预演(stage) → 落盘(commit) ‖ 内存发布(publish)。
 *
 * 盘上事务段 CLI 与 app 共用；内存发布段只在 app 内经 hooks 注入连跑，
 * CLI 安装的内存发布由 app 的 registry watch 重载路径补齐。
 */
export type SkillPipelineErrorCode =
  | 'SKILL_EXISTS'
  | 'EXECUTABLE_SOURCE_BLOCKED'
  | 'EXECUTABLE_SCOPE_BLOCKED'
  | 'VALIDATION_FAILED'
  | 'REVISION_CONFLICT'
  | 'PLUGIN_MEMBER'
  | 'SOURCE_INVALID'
  | 'DEFAULT_WORKSPACE'
  | 'WORKSPACE_REQUIRED'
  | 'TYPE_CONFLICT'
  | 'SKILL_NOT_FOUND'

export class SkillPipelineError extends Error {
  constructor(
    readonly code: SkillPipelineErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SkillPipelineError'
  }
}

export interface InstallSkillRequest {
  source: string
  /** 缺省 user（全局） */
  scope?: 'user' | 'project'
  /** scope=project 时必填：项目 workspace 目录 */
  workspace?: string
  /** 缺省 workspace 路径（{userData}/workspace）：项目层激活判据比对用 */
  defaultWorkspaceDir?: string
  /** 同名已存在时允许覆盖安装 */
  force?: boolean
  /** 远程来源可执行技能门 */
  allowExecutable?: boolean
  /** 市场缓存落地后虽为本地路径，信任语义仍按远程来源处理。 */
  sourceIsRemote?: boolean
  /** 插件成员来源指针（插件安装事务递交成员时传入） */
  installedFrom?: { plugin: string; version?: string }
  installedBy?: string
}

/**
 * 内存发布段挂钩（仅 app 注入）。prepare* 在盘上 commit 之前跑（可失败→回滚），
 * commit 在盘上 commit 之后同步执行——无 await、无 I/O、不可失败。
 */
export interface InstallPublishHooks {
  prepareKnowledge?(args: {
    candidateDir: string
    targetDir: string
    name: string
    type: SkillType
  }): Promise<unknown>
  prepareExecutable?(args: {
    name: string
    domain: SkillType
    modulePath: string
    installedDir: string
  }): Promise<unknown>
  commit?(handle: unknown): void
}

export interface InstallSkillOutcome {
  name: string
  path: string
  scope: 'user' | 'project'
  executionType: 'knowledge' | 'executable'
  type?: SkillType
  warnings: string[]
  registryRevision?: number
  /** 可执行技能的内容寻址构建 hash；知识型安装不返回。 */
  contentHash?: string
}

export async function installSkill(
  request: InstallSkillRequest,
  hooks: InstallPublishHooks = {},
): Promise<InstallSkillOutcome> {
  const scope = request.scope ?? 'user'

  let resolved
  try {
    resolved = await resolveSource(request.source)
  } catch (err) {
    if (err instanceof SourceResolveError) {
      throw new SkillPipelineError('SOURCE_INVALID', err.message, err.details)
    }
    throw err
  }

  try {
    const validation = await validateSkillDir(resolved.stagingDir, {
      directoryName: resolved.sourceType === 'dir' ? resolved.sourceDirName : undefined,
    })
    if (!validation.ok) {
      throw new SkillPipelineError('VALIDATION_FAILED', '技能校验未通过', {
        issues: validation.issues.filter((i) => i.type === 'error'),
      })
    }
    const manifest = validation.parse.manifest!
    const name = manifest.name

    if ((CORE_SKILLS as readonly string[]).includes(name)) {
      throw new SkillPipelineError('VALIDATION_FAILED', `技能名 ${name} 为内置技能保留名`, {
        issues: [{ type: 'error', field: 'name', message: `${name} 为内置技能保留名` }],
      })
    }

    if (validation.executionType === 'executable') {
      if (scope === 'project') {
        throw new SkillPipelineError(
          'EXECUTABLE_SCOPE_BLOCKED',
          '可执行技能不允许安装到项目级（项目层仅知识型）；请安装到全局（--scope user）',
        )
      }
      if ((resolved.remote || request.sourceIsRemote) && !request.allowExecutable) {
        throw new SkillPipelineError(
          'EXECUTABLE_SOURCE_BLOCKED',
          '远程来源包含可执行技能（skill.ts）：代码将进入进程内执行，确认信任后加 --allow-executable 重试',
        )
      }
      return await installExecutable(resolved.stagingDir, name, manifest.type, validation, request, hooks)
    }

    if (scope === 'project') {
      return await installProjectKnowledge(resolved.stagingDir, name, validation, request)
    }
    return await installUserKnowledge(resolved.stagingDir, name, validation, request, hooks)
  } finally {
    await resolved.cleanup()
  }
}

type Validation = Awaited<ReturnType<typeof validateSkillDir>>

async function installUserKnowledge(
  stagingDir: string,
  name: string,
  validation: Validation,
  request: InstallSkillRequest,
  hooks: InstallPublishHooks,
): Promise<InstallSkillOutcome> {
  const manifest = validation.parse.manifest!
  const type: SkillType = manifest.type ?? 'local'
  const autoCompletedType = manifest.type === undefined

  const targetDir = globalSkillDir(type, name)
  const transactionRoot = path.join(globalSkillTypeDir(type), '.tmp')
  const transactionId = `${name}-${createUuid()}`
  const candidateDir = path.join(transactionRoot, `${transactionId}.candidate`)
  const backupDir = path.join(transactionRoot, `${transactionId}.backup`)

  const now = new Date().toISOString()

  await fs.mkdir(transactionRoot, { recursive: true })
  let existing: SkillRegistryEntry | undefined
  let candidateInstalled = false
  let targetBackedUp = false
  let registryRevision: number | undefined

  const rollbackDisk = async (): Promise<unknown[]> => {
    const errors: unknown[] = []
    if (candidateInstalled) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch((error) => errors.push(error))
      candidateInstalled = false
    } else {
      await fs.rm(candidateDir, { recursive: true, force: true }).catch((error) => errors.push(error))
    }
    if (targetBackedUp) {
      await fs.rename(backupDir, targetDir).catch((error) => errors.push(error))
      targetBackedUp = false
    }
    return errors
  }

  try {
    await copySkillSource(stagingDir, candidateDir)
    const handle = await hooks.prepareKnowledge?.({ candidateDir, targetDir, name, type })

    // 同名检查与目录切换都在 registry 跨进程锁内，避免两个安装者同时通过陈旧预检。
    const updated = await commitRegistry(async (draft) => {
      existing = draft.skills[name]
      assertReplaceable(existing, name, type, 'guide-only', request.force)
      const installedAt = existing?.installedAt ?? now

      await writeSidecar(candidateDir, {
        installedAt,
        source: request.source,
        sourceType: 'local',
        installedBy: request.installedBy,
        type,
        autoCompletedType,
        skillType: 'guide-only',
        hasSettings: validation.hasSettings || undefined,
        systemDependencies: validation.systemDependencies,
      })

      try {
        if (await exists(targetDir)) {
          await fs.rename(targetDir, backupDir)
          targetBackedUp = true
        }
        await fs.rename(candidateDir, targetDir)
        candidateInstalled = true
        draft.skills[name] = {
          name,
          type,
          version: manifest.version ?? '1.0.0',
          description: manifest.description,
          path: targetDir,
          source: request.source,
          sourceType: 'local',
          installedAt,
          updatedAt: existing ? now : undefined,
          enabled: true,
          executionType: 'guide-only',
          hasSettings: validation.hasSettings || undefined,
          installedFrom: request.installedFrom,
        }
      } catch (error) {
        const rollbackErrors = await rollbackDisk()
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], '技能安装失败且回滚不完整')
        }
        throw error
      }
    })
    registryRevision = updated.revision

    try {
      hooks.commit?.(handle)
    } catch (error) {
      const rollbackErrors: unknown[] = []
      let registryRestored = false
      await commitRegistry((draft) => {
        if (existing) draft.skills[name] = existing
        else delete draft.skills[name]
      }, { expectedRevision: registryRevision })
        .then(() => { registryRestored = true })
        .catch((rollbackError) => rollbackErrors.push(rollbackError))
      if (registryRestored) rollbackErrors.push(...await rollbackDisk())
      throw new AggregateError([error, ...rollbackErrors], '技能内存发布失败')
    }

    if (targetBackedUp) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {})
    }
    return {
      name,
      path: targetDir,
      scope: 'user',
      executionType: 'knowledge',
      type,
      warnings: validation.issues.filter((i) => i.type === 'warning').map((i) => i.message),
      registryRevision,
    }
  } catch (error) {
    const rollbackErrors = registryRevision === undefined ? await rollbackDisk() : []
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], '技能安装失败且回滚不完整')
    }
    throw error
  }
}

async function installProjectKnowledge(
  stagingDir: string,
  name: string,
  validation: Validation,
  request: InstallSkillRequest,
): Promise<InstallSkillOutcome> {
  const workspace = request.workspace?.trim()
  if (!workspace) {
    throw new SkillPipelineError('WORKSPACE_REQUIRED', '--scope project 需要指定 workspace 目录')
  }
  if (request.defaultWorkspaceDir !== undefined) {
    const active = await isProjectLayerActive(workspace, request.defaultWorkspaceDir)
    if (!active) {
      throw new SkillPipelineError(
        'DEFAULT_WORKSPACE',
        '目标解析为缺省 workspace 路径：该路径被所有缺省 AgentRun 共享，项目级层在此不激活，写入永远不会被读取',
        { workspace },
      )
    }
  }

  const skillsRoot = projectSkillsRoot(workspace)
  const targetDir = path.join(skillsRoot, name)
  const existingDirs = (await projectSkillsRootsForRead(workspace)).map((root) => path.join(root, name))
  const existing = await Promise.all(existingDirs.map(exists))
  const existingDir = existingDirs.find((_candidate, index) => existing[index])
  if (existingDir && !request.force) {
    throw new SkillPipelineError('SKILL_EXISTS', `项目级技能已存在：${name}，使用 --force 覆盖`, {
      name,
      path: existingDir,
    })
  }

  const transactionRoot = path.join(skillsRoot, '.tmp')
  const candidateDir = path.join(transactionRoot, `${name}-${createUuid()}.candidate`)
  await fs.mkdir(transactionRoot, { recursive: true })

  try {
    await copySkillSource(stagingDir, candidateDir)
    await writeSidecar(candidateDir, {
      installedAt: new Date().toISOString(),
      source: request.source,
      sourceType: 'local',
      installedBy: request.installedBy,
      skillType: 'guide-only',
      hasSettings: validation.hasSettings || undefined,
      systemDependencies: validation.systemDependencies,
    })
    await fs.rm(targetDir, { recursive: true, force: true })
    await fs.rename(candidateDir, targetDir)
    return {
      name,
      path: targetDir,
      scope: 'project',
      executionType: 'knowledge',
      type: validation.parse.manifest?.type,
      warnings: validation.issues.filter((i) => i.type === 'warning').map((i) => i.message),
    }
  } catch (error) {
    await fs.rm(candidateDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function installExecutable(
  stagingDir: string,
  name: string,
  declaredType: SkillType | undefined,
  validation: Validation,
  request: InstallSkillRequest,
  hooks: InstallPublishHooks,
): Promise<InstallSkillOutcome> {
  const manifest = validation.parse.manifest!

  // 编译机制随 app 主进程日志栈，懒加载以保持知识型路径（含 CLI 进程）零 Electron 依赖
  const { compileExecutableSkill, ExecutableSkillCompileError } = await import(
    '../executable/compiler.js'
  )

  let candidate
  try {
    candidate = await compileExecutableSkill(path.resolve(stagingDir), name, {
      profile: declaredType === 'browser' ? 'browser' : 'standard',
    })
  } catch (err) {
    if (err instanceof ExecutableSkillCompileError) {
      throw new SkillPipelineError('VALIDATION_FAILED', `技能编译失败：${err.message}`, {
        issues: err.errors.map(
          (e): SkillValidationIssue => ({
            type: 'error',
            field: `${e.file}:${e.line}`,
            message: e.message,
          }),
        ),
      })
    }
    throw err
  }

  const store = new ExecutableSkillStore(globalSkillsRoot())
  try {
    const imported = (await import(pathToFileURL(candidate.modulePath).href)) as {
      default: unknown
    }
    assertDefinedSkill(imported.default)
    const definition = imported.default
    if (definition.name !== name) {
      throw new SkillPipelineError(
        'VALIDATION_FAILED',
        `SKILL.md 声明 ${name}，但 skill.ts 定义 ${definition.name}`,
      )
    }
    if (declaredType && definition.domain !== declaredType) {
      throw new SkillPipelineError(
        'VALIDATION_FAILED',
        `SKILL.md type ${declaredType} 与 skill.ts domain ${definition.domain} 不一致`,
      )
    }
    if (!declaredType && definition.domain === 'browser') {
      throw new SkillPipelineError(
        'VALIDATION_FAILED',
        'Browser executable Skill 必须在 SKILL.md 声明 type: browser',
      )
    }
    const domain = definition.domain as SkillType

    const installedDir = globalSkillDir(domain, name)
    const handle = await hooks.prepareExecutable?.({
      name,
      domain,
      modulePath: candidate.modulePath,
      installedDir,
    })

    const now = new Date().toISOString()
    let existing: SkillRegistryEntry | undefined
    let previousCurrent: string | undefined
    let marked = false
    let currentCommitted = false
    let registryRevision: number | undefined

    const rollbackDisk = async (): Promise<unknown[]> => {
      const errors: unknown[] = []
      if (currentCommitted && previousCurrent) {
        await store.commitCurrent(installedDir, previousCurrent).catch((error) => errors.push(error))
        currentCommitted = false
      } else if (currentCommitted) {
        await fs.rm(path.join(installedDir, 'current'), { force: true }).catch((error) => errors.push(error))
        currentCommitted = false
      }
      if (marked) {
        await store.unmarkPublicationCandidate(name, candidate.hash).catch((error) => errors.push(error))
        marked = false
      }
      return errors
    }

    try {
      // current 指针与 registry 条目在同一把跨进程锁内提交，消除同名并发的陈旧预检窗口。
      const updated = await commitRegistry(async (draft) => {
        existing = draft.skills[name]
        assertReplaceable(existing, name, domain, 'executable', request.force)
        previousCurrent = await fs
          .readFile(path.join(installedDir, 'current'), 'utf8')
          .then((source) => source.trim())
          .catch(() => undefined)

        try {
          await store.markPublicationCandidate(name, candidate.hash)
          marked = true
          await store.commitCurrent(installedDir, candidate.hash)
          currentCommitted = true
          draft.skills[name] = {
            name,
            type: domain,
            version: manifest.version ?? '1.0.0',
            description: manifest.description,
            path: installedDir,
            source: request.source,
            sourceType: 'local',
            installedAt: existing?.installedAt ?? now,
            updatedAt: existing ? now : undefined,
            enabled: true,
            executionType: 'executable',
            installedFrom: request.installedFrom,
          }
        } catch (error) {
          const rollbackErrors = await rollbackDisk()
          if (rollbackErrors.length > 0) {
            throw new AggregateError([error, ...rollbackErrors], '可执行技能安装失败且回滚不完整')
          }
          throw error
        }
      })
      registryRevision = updated.revision

      try {
        hooks.commit?.(handle)
      } catch (error) {
        const rollbackErrors: unknown[] = []
        let registryRestored = false
        await commitRegistry((draft) => {
          if (existing) draft.skills[name] = existing
          else delete draft.skills[name]
        }, { expectedRevision: registryRevision })
          .then(() => { registryRestored = true })
          .catch((rollbackError) => rollbackErrors.push(rollbackError))
        if (registryRestored) rollbackErrors.push(...await rollbackDisk())
        throw new AggregateError([error, ...rollbackErrors], '可执行技能内存发布失败')
      }

      await store.pruneFailedBuilds(name, candidate.hash).catch(() => {})
      return {
        name,
        path: installedDir,
        scope: 'user',
        executionType: 'executable',
        type: domain,
        warnings: validation.issues.filter((i) => i.type === 'warning').map((i) => i.message),
        registryRevision,
        contentHash: candidate.hash,
      }
    } catch (error) {
      const rollbackErrors = registryRevision === undefined ? await rollbackDisk() : []
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], '可执行技能安装失败且回滚不完整')
      }
      throw error
    }
  } catch (error) {
    if (!(error instanceof SkillPipelineError) || error.code !== 'VALIDATION_FAILED') {
      await store.markFailedCandidate(name, candidate.hash, error)
    }
    throw error
  }
}

export interface RemoveSkillRequest {
  name: string
  scope?: 'user' | 'project'
  workspace?: string
}

export async function removeSkill(request: RemoveSkillRequest): Promise<{ name: string; path: string }> {
  const scope = request.scope ?? 'user'
  if (scope === 'project') {
    const workspace = request.workspace?.trim()
    if (!workspace) {
      throw new SkillPipelineError('WORKSPACE_REQUIRED', '--scope project 需要指定 workspace 目录')
    }
    const dir = path.join(projectSkillsRoot(workspace), request.name)
    if (!(await exists(dir))) {
      throw new SkillPipelineError('SKILL_NOT_FOUND', `项目级技能不存在：${request.name}`)
    }
    await fs.rm(dir, { recursive: true, force: true })
    return { name: request.name, path: dir }
  }

  let entry: SkillRegistryEntry | undefined
  await commitRegistry((draft) => {
    entry = draft.skills[request.name]
    if (!entry) {
      throw new SkillPipelineError('SKILL_NOT_FOUND', `技能不存在：${request.name}`)
    }
    if (entry.installedFrom) {
      throw new SkillPipelineError(
        'PLUGIN_MEMBER',
        `${request.name} 是插件 ${entry.installedFrom.plugin} 的成员，不可单独卸载；使用 piskie plugin remove ${entry.installedFrom.plugin}`,
        { plugin: entry.installedFrom.plugin },
      )
    }
    delete draft.skills[request.name]
  })
  await fs.rm(entry!.path, { recursive: true, force: true }).catch(() => {})
  if (entry!.executionType === 'executable') {
    await fs.rm(path.join(globalSkillsRoot(), '.build', request.name), {
      recursive: true,
      force: true,
    }).catch(() => {})
  }
  return { name: request.name, path: entry!.path }
}

/** 仅全局层；插件成员同样适用（启停是成员粒度） */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<SkillRegistryEntry> {
  let result: SkillRegistryEntry | undefined
  await commitRegistry((draft) => {
    const entry = draft.skills[name]
    if (!entry) {
      throw new SkillPipelineError('SKILL_NOT_FOUND', `技能不存在：${name}`)
    }
    entry.enabled = enabled
    entry.updatedAt = new Date().toISOString()
    result = entry
  })
  return result!
}

function assertReplaceable(
  existing: SkillRegistryEntry | undefined,
  name: string,
  type: SkillType,
  executionType: 'guide-only' | 'executable',
  force: boolean | undefined,
): void {
  if (!existing) return
  if (!force) {
    throw new SkillPipelineError('SKILL_EXISTS', `技能已存在：${name}，使用 --force 覆盖`, { name })
  }
  if (existing.type !== type) {
    throw new SkillPipelineError(
      'TYPE_CONFLICT',
      `技能 ${name} 已按 ${existing.type} 类型安装，不能改装为 ${type}；请先卸载`,
      { existingType: existing.type, requestedType: type },
    )
  }
  if (existing.executionType && existing.executionType !== executionType) {
    throw new SkillPipelineError(
      'TYPE_CONFLICT',
      `技能 ${name} 不能变更执行形态（${existing.executionType} → ${executionType}）；请先卸载`,
      { existingExecutionType: existing.executionType, requestedExecutionType: executionType },
    )
  }
}

async function commitRegistry(
  mutate: (draft: Awaited<ReturnType<typeof readRegistry>>) => void | Promise<void>,
  options: UpdateOptions = {},
): Promise<Awaited<ReturnType<typeof readRegistry>>> {
  try {
    return await updateRegistry(globalSkillsRoot(), mutate, options)
  } catch (err) {
    if (err instanceof RegistryLockTimeoutError) {
      throw new SkillPipelineError('REVISION_CONFLICT', `registry 写入竞争超时：${err.message}`)
    }
    if (err instanceof RevisionConflictError) {
      throw new SkillPipelineError('REVISION_CONFLICT', err.message, {
        expectedRevision: err.expected,
        actualRevision: err.actual,
      })
    }
    throw err
  }
}

/** 复制技能源（跳过点条目与依赖/构建产物目录；SKILL.md 必须存在于校验段已保证） */
async function copySkillSource(source: string, target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true })
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules' || entry.name === '__pycache__') continue
    await fs.cp(path.join(source, entry.name), path.join(target, entry.name), { recursive: true })
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
