import { createUuid } from '@shared/utils/identifiers.js';

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertDefinedSkill } from '@electron/piskiepilot/core/skill/define.js'
import { CORE_SKILLS } from '@electron/piskiepilot/core/skill/loader.js'
import { ExecutableSkillStore } from '../skills/executable/store.js'
import type { McpServerConfig } from '@shared/types/mcp.js'
import type {
  PluginInfo,
  PluginManifest,
  PluginMcpMember,
  PluginRecord,
  PluginScope,
  PluginSkillMember,
} from '@shared/types/plugin.js'
import type { SkillType } from '@shared/types/skill.js'

import { resolveSource, SourceResolveError } from '../skills/install/sources.js'
import { validateSkillDir, type SkillValidationResult } from '../skills/install/validate.js'
import { writeSidecar } from '../skills/manifest/sidecar.js'
import {
  globalSkillsRoot,
  isProjectLayerActive,
  projectPluginsRoot,
  projectPluginsRootsForRead,
  projectSkillsRootsForRead,
} from '../skills/store/layout.js'
import { readRegistry, updateRegistry } from '../skills/store/registry.js'
import { readPiskieAdapterMetadata, readPluginManifestFromDir } from './manifest.js'
import { parsePluginMcpFile } from './mcp-members.js'
import {
  globalPluginDir,
  globalPluginsRoot,
  pluginDataDir,
  readPluginsFile,
  updatePluginsFile,
} from './store.js'

export type PluginInstallErrorCode =
  | 'PLUGIN_EXISTS'
  | 'PLUGIN_NOT_FOUND'
  | 'MANIFEST_INVALID'
  | 'MEMBER_VALIDATION_FAILED'
  | 'EXECUTABLE_SOURCE_BLOCKED'
  | 'EXECUTABLE_SCOPE_BLOCKED'
  | 'SOURCE_INVALID'
  | 'WORKSPACE_REQUIRED'
  | 'DEFAULT_WORKSPACE'
  | 'REVISION_CONFLICT'

export class PluginInstallError extends Error {
  constructor(
    readonly code: PluginInstallErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'PluginInstallError'
  }
}

export interface InstallPluginRequest {
  source: string
  /** 适配器临时目录之外的稳定来源记账值。 */
  sourceLabel?: string
  scope?: PluginScope
  workspace?: string
  defaultWorkspaceDir?: string
  force?: boolean
  allowExecutable?: boolean
  /** 市场缓存是本地路径，但仍属于远程来源，必须保留执行代码门。 */
  sourceIsRemote?: boolean
  installedBy?: string
}

export interface RemovePluginRequest {
  name: string
  scope?: PluginScope
  workspace?: string
  purge?: boolean
}

interface CompiledMember {
  hash: string
  modulePath: string
  domain: SkillType
}

interface ValidatedMember {
  name: string
  sourceDir: string
  validation: SkillValidationResult
  compiled?: CompiledMember
}

interface ValidatedPlugin {
  manifest: PluginManifest
  warnings: string[]
  skills: ValidatedMember[]
  mcpServers: Record<string, McpServerConfig>
}

export interface PluginInstallHooks {
  /** 项目级插件由用户亲手安装，展开后的每个 server 在提交后记为可信。 */
  trustProjectServer?(name: string, workspace: string, config: McpServerConfig): Promise<void>
  onChanged?(): void
}

export async function installPlugin(
  configRoot: string,
  request: InstallPluginRequest,
  hooks: PluginInstallHooks = {},
): Promise<PluginInfo> {
  const scope = request.scope ?? 'user'
  let resolved
  try {
    resolved = await resolveSource(request.source)
  } catch (error) {
    if (error instanceof SourceResolveError) {
      throw new PluginInstallError('SOURCE_INVALID', error.message, error.details)
    }
    throw error
  }

  try {
    await assertNoSymlinks(resolved.stagingDir)
    const targetRoot = scope === 'user'
      ? globalPluginsRoot(configRoot)
      : projectPluginsRoot(await requireProjectWorkspace(request))
    const validated = await validatePlugin(
      resolved.stagingDir,
      configRoot,
      scope,
      resolved.remote || request.sourceIsRemote === true,
      request.allowExecutable === true,
    )
    const name = validated.manifest.name
    const workspace = scope === 'project' ? await requireProjectWorkspace(request) : undefined
    if (scope === 'project' && request.defaultWorkspaceDir) {
      if (!(await isProjectLayerActive(workspace, request.defaultWorkspaceDir))) {
        throw new PluginInstallError(
          'DEFAULT_WORKSPACE',
          '目标解析为缺省 workspace 路径：项目级插件层在此不激活，写入永远不会被读取',
        )
      }
    }

    const targetDir = path.join(targetRoot, name)
    await assertInstallable(configRoot, targetDir, validated, scope, workspace, request.force === true)

    const transactionRoot = path.join(targetRoot, '.tmp')
    const transactionId = `${name}-${createUuid()}`
    const candidateDir = path.join(transactionRoot, `${transactionId}.candidate`)
    const backupDir = path.join(transactionRoot, `${transactionId}.backup`)
    await fs.mkdir(transactionRoot, { recursive: true })

    let targetCommitted = false
    let targetBackedUp = false
    let registryCommitted = false
    let pluginStoreCommitted = false
    const registryBefore = scope === 'user' ? await readRegistry(globalSkillsRoot()) : undefined
    const pluginsBefore = scope === 'user' ? await readPluginsFile(configRoot) : undefined
    const published: Array<{ name: string; hash: string }> = []

    try {
      await copyPluginSource(resolved.stagingDir, candidateDir)
      await prepareCandidateMembers(candidateDir, validated, request)

      if (await exists(targetDir)) {
        await fs.rename(targetDir, backupDir)
        targetBackedUp = true
      }
      await fs.rename(candidateDir, targetDir)
      targetCommitted = true

      if (scope === 'user') {
        const store = new ExecutableSkillStore(globalSkillsRoot())
        for (const skill of validated.skills) {
          if (!skill.compiled) continue
          await store.markPublicationCandidate(skill.name, skill.compiled.hash)
          published.push({ name: skill.name, hash: skill.compiled.hash })
        }
        await replacePluginRegistryMembers(validated, targetDir, request, registryBefore!)
        registryCommitted = true

        const record = toRecord(validated, targetDir, request)
        await updatePluginsFile(configRoot, (draft) => {
          draft.plugins = draft.plugins.filter((plugin) => plugin.name !== name)
          draft.plugins.push(record)
          draft.plugins.sort((a, b) => a.name.localeCompare(b.name))
        })
        pluginStoreCommitted = true
      }

      await fs.mkdir(pluginDataDir(configRoot, name), { recursive: true })
      // 首次显式安装即信任；更新沿用旧 fingerprint，配置变化会自然重新过信任门。
      if (scope === 'project' && workspace && hooks.trustProjectServer && !targetBackedUp) {
        const expanded = await parsePluginMcpFile({
          pluginDir: targetDir,
          pluginName: name,
          dataDir: pluginDataDir(configRoot, name),
        })
        for (const [serverName, config] of Object.entries(expanded.servers)) {
          await hooks.trustProjectServer(serverName, workspace, config)
        }
      }
      if (targetBackedUp) await fs.rm(backupDir, { recursive: true, force: true })
      hooks.onChanged?.()
      return toPluginInfo(validated, targetDir, request.sourceLabel ?? request.source, scope)
    } catch (error) {
      const rollbackErrors: unknown[] = []
      if (pluginStoreCommitted && pluginsBefore) {
        await updatePluginsFile(configRoot, (draft) => {
          const before = pluginsBefore.plugins.find((plugin) => plugin.name === validated.manifest.name)
          draft.plugins = draft.plugins.filter((plugin) => plugin.name !== validated.manifest.name)
          if (before) draft.plugins.push(before)
        }).catch((failure) => rollbackErrors.push(failure))
      }
      if (registryCommitted && registryBefore) {
        await restorePluginRegistryMembers(validated.manifest.name, registryBefore)
          .catch((failure) => rollbackErrors.push(failure))
      }
      const store = new ExecutableSkillStore(globalSkillsRoot())
      for (const item of published) {
        await store.unmarkPublicationCandidate(item.name, item.hash)
          .catch((failure) => rollbackErrors.push(failure))
      }
      if (targetCommitted) {
        await fs.rm(targetDir, { recursive: true, force: true }).catch((failure) => rollbackErrors.push(failure))
      } else {
        await fs.rm(candidateDir, { recursive: true, force: true }).catch((failure) => rollbackErrors.push(failure))
      }
      if (targetBackedUp) {
        await fs.rename(backupDir, targetDir).catch((failure) => rollbackErrors.push(failure))
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], '插件安装失败且回滚不完整')
      }
      throw error
    }
  } finally {
    await resolved.cleanup()
  }
}

async function validatePlugin(
  sourceDir: string,
  configRoot: string,
  scope: PluginScope,
  remote: boolean,
  allowExecutable: boolean,
): Promise<ValidatedPlugin> {
  const parsed = await readPluginManifestFromDir(sourceDir)
  if (!parsed.ok) {
    throw new PluginInstallError('MANIFEST_INVALID', '插件 manifest 校验失败', {
      issues: parsed.issues,
      warnings: parsed.warnings,
    })
  }
  const warnings = [...parsed.warnings, ...readPiskieAdapterMetadata(parsed.manifest).warnings]
  const skills: ValidatedMember[] = []
  const seenSkillNames = new Set<string>()
  const skillsRoot = path.join(sourceDir, 'skills')
  for (const directory of await childDirectories(skillsRoot)) {
    const name = path.basename(directory)
    const validation = await validateSkillDir(directory, { directoryName: name })
    if (!validation.ok || !validation.parse.manifest) {
      warnings.push(`skill:${name} 无效，已跳过：${formatMemberIssues(validation.issues)}`)
      continue
    }
    if ((CORE_SKILLS as readonly string[]).includes(validation.parse.manifest.name)) {
      warnings.push(`skill:${name} 使用内置技能保留名，已跳过`)
      continue
    }
    if (seenSkillNames.has(validation.parse.manifest.name)) {
      warnings.push(`skill:${name} 与同包内技能 ${validation.parse.manifest.name} 重名，已跳过`)
      continue
    }
    if (validation.executionType === 'executable') {
      if (scope === 'project') {
        throw new PluginInstallError(
          'EXECUTABLE_SCOPE_BLOCKED',
          `插件 ${parsed.manifest.name} 含可执行成员 ${name}，不能安装到项目级`,
          { member: name },
        )
      }
      if (remote && !allowExecutable) {
        throw new PluginInstallError(
          'EXECUTABLE_SOURCE_BLOCKED',
          `远程插件含可执行成员 ${name}；确认信任后加 --allow-executable 重试`,
          { member: name },
        )
      }
      try {
        skills.push({
          name,
          sourceDir: directory,
          validation,
          compiled: await compileExecutableMember(
            directory,
            name,
            validation.parse.manifest.type,
          ),
        })
        seenSkillNames.add(validation.parse.manifest.name)
      } catch (error) {
        warnings.push(`skill:${name} 编译无效，已跳过：${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      skills.push({ name, sourceDir: directory, validation })
      seenSkillNames.add(validation.parse.manifest.name)
    }
  }

  const mcp = await parsePluginMcpFile({
    pluginDir: sourceDir,
    pluginName: parsed.manifest.name,
    dataDir: pluginDataDir(configRoot, parsed.manifest.name),
  })
  warnings.push(...mcp.warnings)
  warnings.push(...mcp.issues.map((issue) => `mcp:${issue.server ?? 'document'} 无效，已跳过：${issue.message}`))
  return {
    manifest: parsed.manifest,
    warnings,
    skills,
    mcpServers: mcp.servers,
  }
}

function formatMemberIssues(issues: readonly unknown[]): string {
  return issues.map((issue) => {
    if (issue && typeof issue === 'object' && 'message' in issue) return String(issue.message)
    return String(issue)
  }).join('; ')
}

async function compileExecutableMember(
  directory: string,
  name: string,
  declaredType: SkillType | undefined,
): Promise<CompiledMember> {
  const { compileExecutableSkill, ExecutableSkillCompileError } = await import(
    '../skills/executable/compiler.js'
  )
  let candidate
  try {
    candidate = await compileExecutableSkill(path.resolve(directory), name, {
      profile: declaredType === 'browser' ? 'browser' : 'standard',
    })
  } catch (error) {
    if (error instanceof ExecutableSkillCompileError) {
      throw new PluginInstallError('MEMBER_VALIDATION_FAILED', `可执行成员 ${name} 编译失败`, {
        member: name,
        issues: error.errors,
      })
    }
    throw error
  }
  const imported = await import(pathToFileURL(candidate.modulePath).href) as { default: unknown }
  assertDefinedSkill(imported.default)
  if (imported.default.name !== name) {
    throw new PluginInstallError('MEMBER_VALIDATION_FAILED', `成员 ${name} 的 skill.ts 定义名为 ${imported.default.name}`)
  }
  if (declaredType && imported.default.domain !== declaredType) {
    throw new PluginInstallError(
      'MEMBER_VALIDATION_FAILED',
      `成员 ${name} 的 SKILL.md type ${declaredType} 与 skill.ts domain ${imported.default.domain} 不一致`,
    )
  }
  if (!declaredType && imported.default.domain === 'browser') {
    throw new PluginInstallError(
      'MEMBER_VALIDATION_FAILED',
      `Browser executable 成员 ${name} 必须在 SKILL.md 声明 type: browser`,
    )
  }
  return { hash: candidate.hash, modulePath: candidate.modulePath, domain: imported.default.domain }
}

async function prepareCandidateMembers(
  candidateDir: string,
  validated: ValidatedPlugin,
  request: InstallPluginRequest,
): Promise<void> {
  const installedAt = new Date().toISOString()
  const store = new ExecutableSkillStore(globalSkillsRoot())
  for (const member of validated.skills) {
    const memberDir = path.join(candidateDir, 'skills', member.name)
    const manifest = member.validation.parse.manifest!
    await writeSidecar(memberDir, {
      installedAt,
      source: request.sourceLabel ?? request.source,
      sourceType: 'plugin',
      installedBy: request.installedBy,
      type: member.compiled?.domain ?? manifest.type ?? 'local',
      autoCompletedType: manifest.type === undefined,
      skillType: member.compiled ? 'executable' : 'guide-only',
      hasSettings: member.validation.hasSettings || undefined,
      systemDependencies: member.validation.systemDependencies,
    })
    if (member.compiled) {
      await store.commitCurrent(memberDir, member.compiled.hash)
    }
  }
}

async function assertInstallable(
  configRoot: string,
  targetDir: string,
  plugin: ValidatedPlugin,
  scope: PluginScope,
  workspace: string | undefined,
  force: boolean,
): Promise<void> {
  const existingTargetDirs = scope === 'project' && workspace
    ? (await projectPluginsRootsForRead(workspace)).map((root) => path.join(root, plugin.manifest.name))
    : [targetDir]
  const existsAlready = (await Promise.all(existingTargetDirs.map(exists))).some(Boolean)
  if (existsAlready && !force) {
    throw new PluginInstallError('PLUGIN_EXISTS', `插件已存在：${plugin.manifest.name}，使用 --force 更新`)
  }
  if (scope === 'project') {
    const conflicts = new Set<string>()
    const skillRoots = await projectSkillsRootsForRead(workspace!)
    for (const member of plugin.skills) {
      if ((await Promise.all(skillRoots.map((root) => exists(path.join(root, member.name))))).some(Boolean)) {
        conflicts.add(member.name)
      }
    }
    for (const pluginsRoot of await projectPluginsRootsForRead(workspace!)) {
      for (const otherDir of await childDirectories(pluginsRoot)) {
        if (path.basename(otherDir) === plugin.manifest.name) continue
        for (const member of plugin.skills) {
          if (await exists(path.join(otherDir, 'skills', member.name))) conflicts.add(member.name)
        }
      }
    }
    if (conflicts.size > 0) {
      throw new PluginInstallError('MEMBER_VALIDATION_FAILED', '项目层存在同名技能成员', {
        issues: [...conflicts].map((name) => ({ member: `skill:${name}`, message: '同名项目技能已存在' })),
      })
    }
    return
  }

  const registry = await readRegistry(globalSkillsRoot())
  const conflicts = plugin.skills.filter((member) => {
    const existing = registry.skills[member.name]
    return existing && existing.installedFrom?.plugin !== plugin.manifest.name
  })
  if (conflicts.length > 0) {
    throw new PluginInstallError('MEMBER_VALIDATION_FAILED', '全局层存在不属于本插件的同名技能', {
      issues: conflicts.map((member) => ({ member: `skill:${member.name}`, message: '同名技能已存在' })),
    })
  }
  const record = (await readPluginsFile(configRoot)).plugins.find((item) => item.name === plugin.manifest.name)
  if (record && !force) {
    throw new PluginInstallError('PLUGIN_EXISTS', `插件已存在：${plugin.manifest.name}，使用 --force 更新`)
  }
}

async function replacePluginRegistryMembers(
  plugin: ValidatedPlugin,
  targetDir: string,
  request: InstallPluginRequest,
  before: Awaited<ReturnType<typeof readRegistry>>,
): Promise<void> {
  const now = new Date().toISOString()
  await updateRegistry(globalSkillsRoot(), (draft) => {
    for (const [name, entry] of Object.entries(draft.skills)) {
      if (entry.installedFrom?.plugin === plugin.manifest.name) delete draft.skills[name]
    }
    for (const member of plugin.skills) {
      const manifest = member.validation.parse.manifest!
      const old = before.skills[member.name]
      const type = member.compiled?.domain ?? manifest.type ?? 'local'
      draft.skills[member.name] = {
        name: member.name,
        type,
        version: manifest.version ?? plugin.manifest.version ?? '1.0.0',
        description: manifest.description,
        path: path.join(targetDir, 'skills', member.name),
        source: request.sourceLabel ?? request.source,
        sourceType: 'plugin',
        installedAt: old?.installedAt ?? now,
        updatedAt: old ? now : undefined,
        enabled: old?.installedFrom?.plugin === plugin.manifest.name ? old.enabled : true,
        executionType: member.compiled ? 'executable' : 'guide-only',
        hasSettings: member.validation.hasSettings || undefined,
        installedFrom: { plugin: plugin.manifest.name, version: plugin.manifest.version },
      }
    }
  })
}

async function restorePluginRegistryMembers(
  pluginName: string,
  before: Awaited<ReturnType<typeof readRegistry>>,
): Promise<void> {
  const names = new Set(
    Object.values(before.skills)
      .filter((entry) => entry.installedFrom?.plugin === pluginName)
      .map((entry) => entry.name),
  )
  await updateRegistry(globalSkillsRoot(), (draft) => {
    for (const [name, entry] of Object.entries(draft.skills)) {
      if (entry.installedFrom?.plugin === pluginName) delete draft.skills[name]
    }
    for (const name of names) draft.skills[name] = before.skills[name]!
  })
}

function toRecord(plugin: ValidatedPlugin, targetDir: string, request: InstallPluginRequest): PluginRecord {
  return {
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    source: request.sourceLabel ?? request.source,
    scope: 'user',
    path: targetDir,
    installedAt: new Date().toISOString(),
    members: {
      skills: plugin.skills.map((member) => member.name),
      mcpServers: Object.keys(plugin.mcpServers),
    },
  }
}

function toPluginInfo(
  plugin: ValidatedPlugin,
  targetDir: string,
  source: string,
  scope: PluginScope,
): PluginInfo {
  const adapter = readPiskieAdapterMetadata(plugin.manifest)
  const skills: PluginSkillMember[] = plugin.skills.map((member) => ({
    name: member.name,
    executionType: member.compiled ? 'executable' : 'knowledge',
    type: member.compiled?.domain ?? member.validation.parse.manifest?.type,
  }))
  const mcpServers: PluginMcpMember[] = Object.entries(plugin.mcpServers).map(([name, config]) => ({
    name,
    transport: config.command ? 'stdio' : 'streamable_http',
    command: config.command,
    args: config.args,
    url: config.url,
  }))
  return {
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    description: plugin.manifest.description,
    source,
    scope,
    path: targetDir,
    installedAt: new Date().toISOString(),
    manifest: plugin.manifest,
    members: { skills, mcpServers },
    warnings: plugin.warnings,
    compatibility: adapter.compatibility,
  }
}

export async function removePlugin(
  configRoot: string,
  request: RemovePluginRequest,
  hooks: PluginInstallHooks = {},
): Promise<{ name: string; scope: PluginScope; purged: boolean }> {
  const scope = request.scope ?? 'user'
  const workspace = scope === 'project' ? request.workspace?.trim() : undefined
  if (scope === 'project' && !workspace) {
    throw new PluginInstallError('WORKSPACE_REQUIRED', '--scope project 需要指定 workspace')
  }
  const targetDir = scope === 'user'
    ? globalPluginDir(configRoot, request.name)
    : path.join(projectPluginsRoot(workspace!), request.name)
  if (!(await exists(targetDir))) throw new PluginInstallError('PLUGIN_NOT_FOUND', `插件不存在：${request.name}`)

  const transactionRoot = path.join(path.dirname(targetDir), '.tmp')
  const backupDir = path.join(transactionRoot, `${request.name}-${createUuid()}.remove`)
  const registryBefore = scope === 'user' ? await readRegistry(globalSkillsRoot()) : undefined
  const pluginsBefore = scope === 'user' ? await readPluginsFile(configRoot) : undefined
  let registryCommitted = false
  let storeCommitted = false
  await fs.mkdir(transactionRoot, { recursive: true })
  await fs.rename(targetDir, backupDir)
  try {
    if (scope === 'user') {
      await updateRegistry(globalSkillsRoot(), (draft) => {
        for (const [name, entry] of Object.entries(draft.skills)) {
          if (entry.installedFrom?.plugin === request.name) delete draft.skills[name]
        }
      })
      registryCommitted = true
      await updatePluginsFile(configRoot, (draft) => {
        draft.plugins = draft.plugins.filter((plugin) => plugin.name !== request.name)
      })
      storeCommitted = true
    }
    await fs.rm(backupDir, { recursive: true, force: true })
    if (request.purge) await fs.rm(pluginDataDir(configRoot, request.name), { recursive: true, force: true })
    hooks.onChanged?.()
    return { name: request.name, scope, purged: request.purge === true }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    if (storeCommitted && pluginsBefore) {
      const record = pluginsBefore.plugins.find((plugin) => plugin.name === request.name)
      await updatePluginsFile(configRoot, (draft) => {
        draft.plugins = draft.plugins.filter((plugin) => plugin.name !== request.name)
        if (record) draft.plugins.push(record)
      }).catch((failure) => rollbackErrors.push(failure))
    }
    if (registryCommitted && registryBefore) {
      await restorePluginRegistryMembers(request.name, registryBefore)
        .catch((failure) => rollbackErrors.push(failure))
    }
    await fs.rename(backupDir, targetDir).catch((failure) => rollbackErrors.push(failure))
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], '插件卸载失败且回滚不完整')
    }
    throw error
  }
}

async function requireProjectWorkspace(request: InstallPluginRequest): Promise<string> {
  const workspace = request.workspace?.trim()
  if (!workspace) throw new PluginInstallError('WORKSPACE_REQUIRED', '--scope project 需要指定 workspace')
  try {
    return await fs.realpath(workspace)
  } catch {
    return path.resolve(workspace)
  }
}

async function copyPluginSource(source: string, target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true })
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '__pycache__') continue
    await fs.cp(path.join(source, entry.name), path.join(target, entry.name), { recursive: true })
  }
}

async function assertNoSymlinks(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new PluginInstallError('MEMBER_VALIDATION_FAILED', `插件包含符号链接，已拒绝：${item}`)
    }
    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
      await assertNoSymlinks(item)
    }
  }
}

async function childDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
