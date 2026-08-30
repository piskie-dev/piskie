import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const compileExecutableSkill = vi.hoisted(() => vi.fn())

vi.mock('../../executable/compiler.js', () => ({
  compileExecutableSkill,
  ExecutableSkillCompileError: class ExecutableSkillCompileError extends Error {},
}))

import { SkillLoader } from '../../../piskiepilot/core/skill/loader.js'
import { getSkillsDirByType, getSkillsRootDir, setPilotRoot } from '../../../piskiepilot/paths.js'
import { PilotRuntime } from '../../../piskiepilot/runtime/pilot-runtime.js'
import { ToolCallContextFactory, type ToolActivationContext } from '../../../agent/tool-call/context-builder.js'
import { ExecutableSkillStore } from '../../executable/store.js'
import { ToolCatalog, type CatalogSnapshot, type FinalToolFace } from '../../../tools/catalog.js'
import type { ToolContext, ToolOutput } from '../../../tools/types.js'
import { ToolCoordinator } from '../../../tools/coordinator.js'
import { LoadSkillTool } from '../../../tools/skill/load-skill.tool.js'
import { SkillCallTool } from '../../../tools/skill/skill-call.tool.js'
import { ToolSearchTool } from '../../../tools/skill/tool-search.tool.js'
import {
  buildSkillInventory,
  createSkillSearchSource,
} from '../../../core/pilot/skill-inventory.js'
import type { SkillCatalogPort } from '../../../core/pilot/pilot-manager.js'
import { createInstallPublishHooks } from '../publish.js'
import { installSkill, removeSkill, setSkillEnabled } from '../pipeline.js'
import { createSkillsPort } from '../../ports.js'
import { globalSkillsRoot } from '../../store/layout.js'
import { emptyRegistry, readRegistry } from '../../store/registry.js'
import { renderSkillTeachingDoc } from '../../discovery/teaching.js'

const SKILL = 'demo-skill'
const HASH_V1 = '1'.repeat(64)
const HASH_V2 = '2'.repeat(64)
const HASH_BAD = '3'.repeat(64)
const HASH_CONFLICT = '4'.repeat(64)

const FACE: FinalToolFace = {
  scope: 'subagent',
  agentType: 'worker',
  customTools: ['skill_call'],
  exposedSkillFunctions: [],
  excluded: new Set(),
  domains: new Set(['local', 'browser']),
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue
  })
  return { promise, resolve: resolvePromise }
}

describe('installSkill：可执行技能统一发布链', () => {
  let root: string
  let staging: string
  let browserLoader: SkillLoader
  let catalog: ToolCatalog
  let store: ExecutableSkillStore
  let runtime: PilotRuntime
  let hooks: ReturnType<typeof createInstallPublishHooks>

  beforeEach(async () => {
    compileExecutableSkill.mockReset()
    root = await import('node:fs/promises').then(({ mkdtemp }) => (
      mkdtemp(path.join(tmpdir(), 'executable-pipeline-'))
    ))
    setPilotRoot(path.join(root, 'pilot'))
    staging = path.join(root, 'staging', SKILL)
    await mkdir(staging, { recursive: true })
    await writeSkillSource('1.0.0')

    browserLoader = makeLoader('browser')
    catalog = new ToolCatalog()
    store = new ExecutableSkillStore(getSkillsRootDir())
    const instance = Object.create(PilotRuntime.prototype) as Record<string, unknown>
    Object.assign(instance, {
      initialized: true,
      toolCatalog: catalog,
      executableStore: store,
      registry: emptyRegistry(),
      browserLoader,
      localLoader: makeLoader('local'),
    })
    runtime = instance as unknown as PilotRuntime
    hooks = createInstallPublishHooks(runtime)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    setPilotRoot(path.join(process.cwd(), '.piskiepilot'))
    await rm(root, { recursive: true, force: true })
  })

  function makeLoader(type: 'browser' | 'local'): SkillLoader {
    return new SkillLoader({
      roots: [{
        dir: getSkillsDirByType(type),
        trust: 'custom',
        entryPoint: 'skill_call',
      }],
      typeFilter: type,
    })
  }

  async function writeSkillSource(version: string): Promise<void> {
    await writeFile(path.join(staging, 'SKILL.md'), [
      '---',
      `name: ${SKILL}`,
      'type: browser',
      `version: "${version}"`,
      'description: executable pipeline fixture',
      '---',
      '',
      '# Fixture',
      '',
    ].join('\n'), 'utf8')
    await writeFile(path.join(staging, 'skill.ts'), 'export default {}\n', 'utf8')
  }

  async function makeCandidate(input: {
    hash: string
    text: string
    functions?: string[]
    invalidContract?: boolean
    hostParameter?: boolean
    reference?: string
  }) {
    const buildDir = store.buildDir(SKILL, input.hash)
    const moduleDir = path.join(buildDir, 'module')
    const modulePath = path.join(moduleDir, 'skill.js')
    await mkdir(moduleDir, { recursive: true })
    const zodUrl = pathToFileURL(resolve('node_modules/zod/index.js')).href
    const functions = (input.functions ?? ['run']).map((name) => `${JSON.stringify(name)}: {
      description: ${JSON.stringify(`${name} ${input.text}`)},
      params: ${input.invalidContract
        ? '{}'
        : input.hostParameter
          ? 'z.object({ value: z.string().optional(), browserId: z.string() })'
          : 'z.object({ value: z.string().optional() })'},
      async run(params) { return { ok: true, text: ${JSON.stringify(input.text)} + (params.value ?? '') }; },
    }`).join(',\n')
    await writeFile(modulePath, `import { z } from ${JSON.stringify(zodUrl)};
export default {
  name: ${JSON.stringify(SKILL)},
  domain: 'browser',
  functions: { ${functions} },
};
`, 'utf8')
    await writeFile(path.join(moduleDir, 'SKILL.md'), await readFile(path.join(staging, 'SKILL.md')), 'utf8')
    if (input.reference) {
      const referencesDir = path.join(moduleDir, 'references')
      await mkdir(referencesDir, { recursive: true })
      await writeFile(path.join(referencesDir, 'details.md'), input.reference, 'utf8')
    }
    await writeFile(path.join(buildDir, '.complete'), `${input.hash}\n`, 'utf8')
    return { hash: input.hash, buildDir, modulePath, profile: 'browser' as const }
  }

  function install(force = false) {
    return installSkill({
      source: staging,
      scope: 'user',
      force,
      allowExecutable: true,
    }, hooks)
  }

  async function currentHash(): Promise<string> {
    return (await readFile(path.join(getSkillsDirByType('browser'), SKILL, 'current'), 'utf8')).trim()
  }

  async function callText(snapshot: CatalogSnapshot): Promise<string> {
    const resolved = snapshot.resolveSkillFunction(SKILL, 'run')
    expect(resolved.kind).toBe('resolved')
    if (resolved.kind !== 'resolved') throw new Error('fixture did not resolve')
    const output = await resolved.entry.tool.execute({}, toolContext()) as ToolOutput<unknown>
    return output.text
  }

  it('提交 current、registry、Loader 与 Catalog，并只让未来快照看到更新', async () => {
    const v1 = await makeCandidate({ hash: HASH_V1, text: 'v1' })
    compileExecutableSkill.mockResolvedValueOnce(v1)
    const first = await install()
    const v1Snapshot = catalog.snapshot(FACE)

    expect(first).toMatchObject({
      name: SKILL,
      executionType: 'executable',
      contentHash: HASH_V1,
      registryRevision: 1,
    })
    expect(await currentHash()).toBe(HASH_V1)
    expect(await callText(v1Snapshot)).toBe('v1')

    await writeSkillSource('2.0.0')
    const v2 = await makeCandidate({ hash: HASH_V2, text: 'v2' })
    compileExecutableSkill.mockResolvedValueOnce(v2)
    await install(true)

    expect(await currentHash()).toBe(HASH_V2)
    expect(await callText(v1Snapshot)).toBe('v1')
    expect(await callText(catalog.snapshot(FACE))).toBe('v2')
    const registry = await readRegistry(globalSkillsRoot())
    expect(registry.skills[SKILL]).toMatchObject({ version: '2.0.0', enabled: true })
    await expect(access(staging)).resolves.toBeUndefined()
  })

  it('统一 SkillsPort 发布后进入管理、发现与 normal/plan 的 load_skill -> skill_call 链', async () => {
    const candidate = await makeCandidate({ hash: HASH_V1, text: 'published-browser-result' })
    compileExecutableSkill.mockResolvedValueOnce(candidate)
    const changed = vi.fn()
    const skills = createSkillsPort({
      runtime: {
        getFunctionSignatures: (name) => {
          const module = browserLoader.getSkillModule(name)
          return module ? Object.keys(module.functions).map((functionName) => ({ name: functionName })) : undefined
        },
        getResourceRoot: (name) => browserLoader.getSkillResourceRoot(name),
        installHooks: hooks,
        onChanged: changed,
      },
    })

    const outcome = await skills.install({
      source: staging,
      scope: 'user',
      allowExecutable: true,
    })
    expect(outcome).toMatchObject({
      name: SKILL,
      type: 'browser',
      executionType: 'executable',
      contentHash: HASH_V1,
      registryRevision: 1,
    })
    expect(changed).toHaveBeenCalledTimes(1)

    const catalogPort = {
      getLoadedSkillModule: (name: string) => browserLoader.getSkillModule(name),
      getSkillDocs: async (name: string) => browserLoader.getSkillInfo(name)?.docs ?? '',
      getSkillResourceRoot: (name: string) => browserLoader.getSkillResourceRoot(name),
      classifySkill: vi.fn(async () => 'unknown' as const),
      listManagedSkills: (filter) => skills.list(filter),
    } as SkillCatalogPort

    const managed = await skills.list({ scope: 'user' })
    expect(managed).toEqual([expect.objectContaining({
      name: SKILL,
      description: 'executable pipeline fixture',
      type: 'browser',
      scope: 'user',
      enabled: true,
      executionType: 'executable',
    })])
    const detail = await skills.show(SKILL, { scope: 'user' })
    expect(detail.body).toContain('# Fixture')
    expect(detail.functions).toEqual([{ name: 'run' }])
    expect(detail.files).toContain('SKILL.md')

    const inventory = await buildSkillInventory(catalogPort, { contextWindowTokens: 100_000 })
    expect(inventory.text).toContain(`- ${SKILL}`)
    expect(inventory.text).toContain('executable pipeline fixture')
    expect(inventory.text).toContain('[functions: run]')
    expect(inventory.snapshot.entries[SKILL]).toMatchObject({ scope: 'user', tier: 'full' })

    const searchSource = createSkillSearchSource(catalogPort)
    const searchable = await searchSource.listSearchableSkills()
    expect(searchable).toEqual([expect.objectContaining({
      name: SKILL,
      type: 'browser',
      scope: 'user',
      functions: ['run'],
      body: expect.stringContaining('# Fixture'),
    })])
    const searched = await new ToolSearchTool(searchSource).execute(
      { query: 'executable pipeline' },
      toolContext(),
    )
    expect(searched.ok).toBe(true)
    expect(searched.text).toContain(SKILL)
    expect(searched.text).toContain('load_skill')

    catalog.register(new SkillCallTool(), 'builtin')
    catalog.register(new LoadSkillTool(catalogPort), 'builtin')
    for (const mode of ['normal', 'plan'] as const) {
      const snapshot = catalog.snapshot({
        scope: 'main',
        agentType: 'main',
        customTools: ['load_skill', 'skill_call'],
        exposedSkillFunctions: [],
        excluded: new Set(),
        domains: new Set(['local', 'browser']),
      })
      const coordinator = new ToolCoordinator({
        contexts: new ToolCallContextFactory({
          activation: activation(mode),
          signal: () => new AbortController().signal,
        }),
      })

      const teaching = await coordinator.run({
        modelName: 'load_skill',
        rawParams: { skill: SKILL },
        callId: `${mode}-load`,
      }, snapshot)
      if ('suspended' in teaching) throw new Error('load_skill unexpectedly suspended')
      expect(teaching.result.ok).toBe(true)
      expect(teaching.result.text).toContain('# Fixture')
      expect(teaching.result.text).toContain('run(value)')

      const called = await coordinator.run({
        modelName: 'skill_call',
        rawParams: { skill: SKILL, function: 'run', args: { value: `-${mode}` } },
        callId: `${mode}-call`,
      }, snapshot)
      if ('suspended' in called) throw new Error('skill_call unexpectedly suspended')
      expect(called.result).toEqual({ ok: true, text: `published-browser-result-${mode}` })
    }
  })

  it('load_skill 教学从当前 build 读取正文并列出可直接读取的 reference 绝对路径', async () => {
    const reference = '# Current reference\n\nOnly this build should be visible.\n'
    const candidate = await makeCandidate({
      hash: HASH_V1,
      text: 'current executable',
      reference,
    })
    compileExecutableSkill.mockResolvedValueOnce(candidate)
    await install()

    const port = {
      getLoadedSkillModule: (name: string) => browserLoader.getSkillModule(name),
      classifySkill: vi.fn(async () => 'unknown' as const),
      getSkillDocs: vi.fn(async (name: string) => browserLoader.getSkillInfo(name)?.docs ?? ''),
      getSkillResourceRoot: (name: string) => browserLoader.getSkillResourceRoot(name),
    }
    const teaching = await renderSkillTeachingDoc(port, SKILL)
    const referencePath = path.join(candidate.buildDir, 'module', 'references', 'details.md')

    expect(teaching.found).toBe(true)
    expect(teaching.content).toContain('# Fixture')
    expect(teaching.content).toContain(referencePath)
    expect(teaching.content).not.toContain('name: demo-skill')
    expect(teaching.content).not.toContain(path.join(getSkillsDirByType('browser'), SKILL, 'current'))
    await expect(readFile(referencePath, 'utf8')).resolves.toBe(reference)
  })

  it('同名无 force 并发安装只有锁内先提交者成功', async () => {
    const v1 = await makeCandidate({ hash: HASH_V1, text: 'v1' })
    const v2 = await makeCandidate({ hash: HASH_V2, text: 'v2' })
    const releaseFirstCompile = deferred<typeof v1>()
    compileExecutableSkill
      .mockImplementationOnce(() => releaseFirstCompile.promise)
      .mockResolvedValueOnce(v2)

    const first = install()
    await vi.waitFor(() => expect(compileExecutableSkill).toHaveBeenCalledTimes(1))
    await writeSkillSource('2.0.0')
    const second = install()
    await expect(second).resolves.toMatchObject({ contentHash: HASH_V2 })

    releaseFirstCompile.resolve(v1)
    await expect(first).rejects.toMatchObject({ code: 'SKILL_EXISTS' })
    expect(await currentHash()).toBe(HASH_V2)
    expect(await callText(catalog.snapshot(FACE))).toBe('v2')
  })

  it('编译、契约和 Catalog 预提交失败均保持 V1 完整不变', async () => {
    const v1 = await makeCandidate({ hash: HASH_V1, text: 'v1' })
    compileExecutableSkill.mockResolvedValueOnce(v1)
    await install()
    const loadedV1 = browserLoader.getSkillModule(SKILL)

    compileExecutableSkill.mockRejectedValueOnce(new Error('compile failed'))
    await expect(install(true)).rejects.toThrow('compile failed')

    const invalid = await makeCandidate({ hash: HASH_BAD, text: 'bad', invalidContract: true })
    compileExecutableSkill.mockResolvedValueOnce(invalid)
    await expect(install(true)).rejects.toThrow(/zod params schema/)

    const hostParameter = await makeCandidate({
      hash: '5'.repeat(64),
      text: 'host-parameter',
      hostParameter: true,
    })
    compileExecutableSkill.mockResolvedValueOnce(hostParameter)
    await expect(install(true)).rejects.toThrow(/cannot expose host runtime parameters: browserId/)

    const conflict = await makeCandidate({
      hash: HASH_CONFLICT,
      text: 'conflict',
      functions: ['run', 'blocked'],
    })
    catalog.register(nativeTool(`${SKILL}_blocked`), 'builtin')
    compileExecutableSkill.mockResolvedValueOnce(conflict)
    await expect(install(true)).rejects.toThrow(/modelName conflict/)

    expect(await currentHash()).toBe(HASH_V1)
    expect(browserLoader.getSkillModule(SKILL)).toBe(loadedV1)
    expect(await callText(catalog.snapshot(FACE))).toBe('v1')
    await expect(access(path.join(invalid.buildDir, '.failed'))).resolves.toBeUndefined()
    await expect(access(path.join(conflict.buildDir, '.failed'))).resolves.toBeUndefined()
  })

  it('current 写入失败时不改 registry/Loader/Catalog，并可在修复后重试', async () => {
    const v1 = await makeCandidate({ hash: HASH_V1, text: 'v1' })
    compileExecutableSkill.mockResolvedValueOnce(v1)
    await install()

    await writeSkillSource('2.0.0')
    const v2 = await makeCandidate({ hash: HASH_V2, text: 'v2' })
    compileExecutableSkill.mockResolvedValueOnce(v2)
    vi.spyOn(ExecutableSkillStore.prototype, 'commitCurrent')
      .mockRejectedValueOnce(new Error('current write failed'))

    await expect(install(true)).rejects.toThrow('current write failed')
    expect(await currentHash()).toBe(HASH_V1)
    expect(await callText(catalog.snapshot(FACE))).toBe('v1')
    expect((await readRegistry(globalSkillsRoot())).skills[SKILL]?.version).toBe('1.0.0')
    await expect(access(path.join(v2.buildDir, '.published'))).rejects.toThrow()
    await expect(access(path.join(v2.buildDir, '.failed'))).resolves.toBeUndefined()

    vi.restoreAllMocks()
    compileExecutableSkill.mockResolvedValueOnce(v2)
    await expect(install(true)).resolves.toMatchObject({ contentHash: HASH_V2 })
  })

  it('清理旧失败构建失败不会把已完成发布改判为失败', async () => {
    const v1 = await makeCandidate({ hash: HASH_V1, text: 'v1' })
    compileExecutableSkill.mockResolvedValueOnce(v1)
    vi.spyOn(ExecutableSkillStore.prototype, 'pruneFailedBuilds')
      .mockRejectedValueOnce(new Error('cleanup failed'))

    await expect(install()).resolves.toMatchObject({ contentHash: HASH_V1 })
    expect(await currentHash()).toBe(HASH_V1)
    expect(await callText(catalog.snapshot(FACE))).toBe('v1')
  })

  it('registry 启停/卸载经 sync 收敛，重新启用复用 current 而不重新编译', async () => {
    const v1 = await makeCandidate({ hash: HASH_V1, text: 'v1' })
    compileExecutableSkill.mockResolvedValueOnce(v1)
    await install()

    await setSkillEnabled(SKILL, false)
    await runtime.syncWithRegistry()
    expect(browserLoader.getSkillModule(SKILL)).toBeUndefined()
    expect(catalog.snapshot(FACE).resolveSkillFunction(SKILL, 'run')).toEqual({ kind: 'notCallable' })

    await setSkillEnabled(SKILL, true)
    await runtime.syncWithRegistry()
    expect(await callText(catalog.snapshot(FACE))).toBe('v1')
    expect(compileExecutableSkill).toHaveBeenCalledTimes(1)

    await removeSkill({ name: SKILL })
    await runtime.syncWithRegistry()
    expect((await readRegistry(globalSkillsRoot())).skills[SKILL]).toBeUndefined()
    await expect(access(v1.buildDir)).rejects.toThrow()
  })
})

function toolContext(): ToolContext {
  const generatedBrowser = {
    page: {
      navigate: vi.fn(),
      currentPage: vi.fn(),
      click: vi.fn(),
      fill: vi.fn(),
      select: vi.fn(),
      press: vi.fn(),
      waitFor: vi.fn(),
      extractText: vi.fn(),
      extractList: vi.fn(),
    },
  }
  return {
    agentId: 'worker-1',
    callId: 'call-1',
    workspace: { dir: process.cwd(), tempDir: tmpdir() },
    signal: new AbortController().signal,
    declareTerminal: vi.fn(),
    post: vi.fn(() => true),
    log: vi.fn(),
    agentType: 'worker',
    agentSpec: 'browser-worker',
    mainAgentId: 'main-1',
    runConfig: { name: 'run', description: '', promptTemplate: '' },
    resourceIds: { browserId: 'browser-1' },
    currentModel: 'provider::model',
    modes: { modeId: () => 'normal', approvalMode: () => 'auto' },
    browser: {
      createGeneratedRuntime: vi.fn(() => generatedBrowser),
    } as unknown as ToolContext['browser'],
  }
}

function activation(mode: 'normal' | 'plan'): ToolActivationContext {
  const context = toolContext()
  return {
    agentType: 'main',
    agentSpec: 'director',
    agentId: `${mode}-director`,
    mainAgentId: `${mode}-director`,
    runConfig: { name: mode, description: '', promptTemplate: '' },
    resourceIds: context.resourceIds,
    currentModel: () => context.currentModel,
    workspace: context.workspace,
    modes: { modeId: () => mode, approvalMode: () => 'auto' },
    browser: context.browser,
    post: () => true,
  }
}

function nativeTool(name: string) {
  return {
    def: {
      name,
      description: name,
      schema: { parse: (value: unknown) => value },
      scope: 'shared' as const,
      effects: [],
    },
    async execute() {
      return { ok: true as const, text: name }
    },
  }
}
