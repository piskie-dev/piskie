import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setPilotRoot } from '@electron/piskiepilot/paths.js'

import {
  installSkill,
  removeSkill,
  setSkillEnabled,
  SkillPipelineError,
} from '../pipeline'
import { readRegistry } from '../../store/registry'
import { globalSkillsRoot } from '../../store/layout'

let root: string
let sourceRoot: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pipeline-root-'))
  sourceRoot = await mkdtemp(path.join(tmpdir(), 'pipeline-src-'))
  setPilotRoot(path.join(root, 'piskiepilot'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(sourceRoot, { recursive: true, force: true })
})

async function makeKnowledgeSource(
  name: string,
  frontmatter: Record<string, string> = {},
): Promise<string> {
  const dir = path.join(sourceRoot, name)
  await mkdir(dir, { recursive: true })
  const fm = Object.entries({ name, description: `${name} 的说明`, ...frontmatter })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  await writeFile(path.join(dir, 'SKILL.md'), `---\n${fm}\n---\n\n# ${name}\n正文内容\n`, 'utf8')
  return dir
}

describe('installSkill：全局知识型', () => {
  it('安装成功：目录落位 + sidecar 写入 + registry CAS 记账', async () => {
    const source = await makeKnowledgeSource('pdf-tools')
    const outcome = await installSkill({ source })

    expect(outcome).toMatchObject({
      name: 'pdf-tools',
      scope: 'user',
      executionType: 'knowledge',
      type: 'local',
      registryRevision: 1,
    })
    expect(existsSync(path.join(outcome.path, 'SKILL.md'))).toBe(true)

    const sidecar = JSON.parse(
      await readFile(path.join(outcome.path, '.skill-meta.json'), 'utf8'),
    )
    expect(sidecar.type).toBe('local')
    expect(sidecar.autoCompletedType).toBe(true)
    expect(sidecar.skillType).toBe('guide-only')

    const registry = await readRegistry(globalSkillsRoot())
    expect(registry.revision).toBe(1)
    expect(registry.skills['pdf-tools']).toMatchObject({
      name: 'pdf-tools',
      type: 'local',
      enabled: true,
      executionType: 'guide-only',
    })
  })

  it('SKILL.md 不被改写：frontmatter 无 type 时原文保持，推断进 sidecar', async () => {
    const source = await makeKnowledgeSource('no-type')
    const before = await readFile(path.join(source, 'SKILL.md'), 'utf8')
    const outcome = await installSkill({ source })
    const after = await readFile(path.join(outcome.path, 'SKILL.md'), 'utf8')
    expect(after).toBe(before)
    expect(after).not.toContain('type:')
  })

  it('frontmatter 显式 type 时不标记推断', async () => {
    const source = await makeKnowledgeSource('typed-skill', { type: 'browser' })
    const outcome = await installSkill({ source })
    expect(outcome.type).toBe('browser')
    const sidecar = JSON.parse(
      await readFile(path.join(outcome.path, '.skill-meta.json'), 'utf8'),
    )
    expect(sidecar.autoCompletedType).toBe(false)
  })

  it('同名已存在且无 force → SKILL_EXISTS；force 覆盖保留 installedAt', async () => {
    const source = await makeKnowledgeSource('dup-skill')
    const first = await installSkill({ source })
    const firstRegistry = await readRegistry(globalSkillsRoot())
    const installedAt = firstRegistry.skills['dup-skill'].installedAt

    await expect(installSkill({ source })).rejects.toMatchObject({ code: 'SKILL_EXISTS' })

    const second = await installSkill({ source, force: true })
    expect(second.registryRevision).toBe(2)
    const registry = await readRegistry(globalSkillsRoot())
    expect(registry.skills['dup-skill'].installedAt).toBe(installedAt)
    expect(registry.skills['dup-skill'].updatedAt).toBeDefined()
    expect(first.path).toBe(second.path)
  })

  it('force 也不能跨 type 改装 → TYPE_CONFLICT', async () => {
    await installSkill({ source: await makeKnowledgeSource('cross-type') })
    const browserSource = await makeKnowledgeSource('cross-type', { type: 'browser' })
    await expect(installSkill({ source: browserSource, force: true })).rejects.toMatchObject({
      code: 'TYPE_CONFLICT',
    })
  })

  it('name 与目录名不一致（本地目录来源）→ VALIDATION_FAILED', async () => {
    const dir = path.join(sourceRoot, 'wrong-dir')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'SKILL.md'),
      '---\nname: other-name\ndescription: x\n---\n\n正文\n',
      'utf8',
    )
    await expect(installSkill({ source: dir })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('内置保留名 → VALIDATION_FAILED', async () => {
    const source = await makeKnowledgeSource('browser')
    await expect(installSkill({ source })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('缺 description → VALIDATION_FAILED 且携带逐条 issue', async () => {
    const dir = path.join(sourceRoot, 'no-desc')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: no-desc\n---\n\n正文\n', 'utf8')
    try {
      await installSkill({ source: dir })
      expect.unreachable()
    } catch (err) {
      const e = err as SkillPipelineError
      expect(e.code).toBe('VALIDATION_FAILED')
      const issues = e.details?.issues as Array<{ field: string }>
      expect(issues.some((i) => i.field === 'DESCRIPTION_MISSING')).toBe(true)
    }
  })

  it('prepare 钩子失败 → 回滚：目录不落位、registry 不记账', async () => {
    const source = await makeKnowledgeSource('rollback-prepare')
    await expect(
      installSkill(
        { source },
        {
          prepareKnowledge: async () => {
            throw new Error('发布预校验失败')
          },
        },
      ),
    ).rejects.toThrow('发布预校验失败')

    const registry = await readRegistry(globalSkillsRoot())
    expect(registry.skills['rollback-prepare']).toBeUndefined()
    expect(existsSync(path.join(globalSkillsRoot(), 'local', 'rollback-prepare'))).toBe(false)
  })

  it('覆盖安装的 prepare 失败 → 旧版本目录复原', async () => {
    const source = await makeKnowledgeSource('restore-me')
    await installSkill({ source })
    const targetDir = path.join(globalSkillsRoot(), 'local', 'restore-me')
    await writeFile(path.join(targetDir, 'marker.txt'), 'v1', 'utf8')

    await expect(
      installSkill(
        { source, force: true },
        {
          prepareKnowledge: async () => {
            throw new Error('boom')
          },
        },
      ),
    ).rejects.toThrow('boom')

    expect(await readFile(path.join(targetDir, 'marker.txt'), 'utf8')).toBe('v1')
    const registry = await readRegistry(globalSkillsRoot())
    expect(registry.skills['restore-me']).toBeDefined()
  })

  it('commit 钩子按序拿到 prepare 的句柄（两段连跑）', async () => {
    const source = await makeKnowledgeSource('hook-order')
    const calls: string[] = []
    await installSkill(
      { source },
      {
        prepareKnowledge: async ({ candidateDir }) => {
          calls.push('prepare')
          expect(existsSync(path.join(candidateDir, 'SKILL.md'))).toBe(true)
          return 'HANDLE'
        },
        commit: (handle) => {
          calls.push(`commit:${String(handle)}`)
        },
      },
    )
    expect(calls).toEqual(['prepare', 'commit:HANDLE'])
  })
})

describe('installSkill：项目级', () => {
  it('项目级安装落位 {workspace}/.piskie/skills，无 registry 记账', async () => {
    const workspace = path.join(root, 'my-project')
    await mkdir(workspace, { recursive: true })
    const source = await makeKnowledgeSource('proj-skill')

    const outcome = await installSkill({
      source,
      scope: 'project',
      workspace,
      defaultWorkspaceDir: path.join(root, 'default-ws'),
    })
    expect(outcome.scope).toBe('project')
    expect(outcome.path).toBe(path.join(workspace, '.piskie', 'skills', 'proj-skill'))
    expect(existsSync(path.join(outcome.path, 'SKILL.md'))).toBe(true)

    const registry = await readRegistry(globalSkillsRoot())
    expect(registry.revision).toBe(0)
    expect(registry.skills['proj-skill']).toBeUndefined()
  })

  it('项目级拒可执行 → EXECUTABLE_SCOPE_BLOCKED', async () => {
    const workspace = path.join(root, 'proj2')
    await mkdir(workspace, { recursive: true })
    const source = await makeKnowledgeSource('exec-skill')
    await writeFile(path.join(source, 'skill.ts'), 'export default {} as never', 'utf8')

    await expect(
      installSkill({ source, scope: 'project', workspace }),
    ).rejects.toMatchObject({ code: 'EXECUTABLE_SCOPE_BLOCKED' })
  })

  it('目标解析为缺省 workspace 路径 → DEFAULT_WORKSPACE（显式配置同样拒绝）', async () => {
    const defaultWs = path.join(root, 'userData', 'workspace')
    await mkdir(defaultWs, { recursive: true })
    const source = await makeKnowledgeSource('default-ws-skill')

    await expect(
      installSkill({
        source,
        scope: 'project',
        workspace: defaultWs,
        defaultWorkspaceDir: defaultWs,
      }),
    ).rejects.toMatchObject({ code: 'DEFAULT_WORKSPACE' })

    // 符号链接指向缺省路径同样按 realpath 判死
    const alias = path.join(root, 'ws-alias')
    await symlink(defaultWs, alias, 'dir')
    await expect(
      installSkill({
        source,
        scope: 'project',
        workspace: alias,
        defaultWorkspaceDir: defaultWs,
      }),
    ).rejects.toMatchObject({ code: 'DEFAULT_WORKSPACE' })
  })

  it('scope=project 缺 workspace → WORKSPACE_REQUIRED', async () => {
    const source = await makeKnowledgeSource('no-ws')
    await expect(installSkill({ source, scope: 'project' })).rejects.toMatchObject({
      code: 'WORKSPACE_REQUIRED',
    })
  })
})

describe('removeSkill / setSkillEnabled', () => {
  it('卸载：registry 先行删除 + 目录移除', async () => {
    const outcome = await installSkill({ source: await makeKnowledgeSource('to-remove') })
    const removed = await removeSkill({ name: 'to-remove' })
    expect(removed.path).toBe(outcome.path)
    expect(existsSync(outcome.path)).toBe(false)
    const registry = await readRegistry(globalSkillsRoot())
    expect(registry.skills['to-remove']).toBeUndefined()
    expect(registry.revision).toBe(2)
  })

  it('插件成员拒绝单删 → PLUGIN_MEMBER', async () => {
    await installSkill({
      source: await makeKnowledgeSource('member-skill'),
      installedFrom: { plugin: 'jira-kit', version: '1.0.0' },
    })
    await expect(removeSkill({ name: 'member-skill' })).rejects.toMatchObject({
      code: 'PLUGIN_MEMBER',
    })
  })

  it('启停走 CAS，enabled 翻转', async () => {
    await installSkill({ source: await makeKnowledgeSource('toggle-skill') })
    await setSkillEnabled('toggle-skill', false)
    let registry = await readRegistry(globalSkillsRoot())
    expect(registry.skills['toggle-skill'].enabled).toBe(false)
    await setSkillEnabled('toggle-skill', true)
    registry = await readRegistry(globalSkillsRoot())
    expect(registry.skills['toggle-skill'].enabled).toBe(true)
    expect(registry.revision).toBe(3)
  })

  it('不存在的技能 → SKILL_NOT_FOUND', async () => {
    await expect(removeSkill({ name: 'ghost' })).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
    await expect(setSkillEnabled('ghost', true)).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
  })
})

describe('installSkill：来源门', () => {
  it('zip 来源解压安装（含单根目录包装下钻）', async () => {
    await makeKnowledgeSource('zip-skill')
    const zipPath = path.join(sourceRoot, 'zip-skill.zip')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)('zip', ['-r', zipPath, 'zip-skill'], { cwd: sourceRoot })

    const outcome = await installSkill({ source: zipPath })
    expect(outcome.name).toBe('zip-skill')
    expect(existsSync(path.join(outcome.path, 'SKILL.md'))).toBe(true)
  })

  it('来源路径不存在 → SOURCE_INVALID', async () => {
    await expect(installSkill({ source: path.join(sourceRoot, 'missing') })).rejects.toMatchObject({
      code: 'SOURCE_INVALID',
    })
  })
})
