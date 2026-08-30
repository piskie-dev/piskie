import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setPilotRoot } from '@electron/piskiepilot/paths.js'

import { createSkillsPort } from '../ports'
import { globalSkillDir, globalSkillsRoot } from '../store/layout'
import { updateRegistry } from '../store/registry'

let root: string
let sourceRoot: string
let workspace: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ports-root-'))
  sourceRoot = await mkdtemp(path.join(tmpdir(), 'ports-src-'))
  workspace = path.join(root, 'ws')
  await mkdir(workspace, { recursive: true })
  setPilotRoot(path.join(root, 'piskiepilot'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(sourceRoot, { recursive: true, force: true })
})

let sourceSeq = 0

async function makeSource(name: string, description: string): Promise<string> {
  const dir = path.join(sourceRoot, `batch-${sourceSeq++}`, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n正文\n`,
    'utf8',
  )
  return dir
}

function portWithBuiltin() {
  return createSkillsPort({
    runtime: {
      listBuiltin: () => [
        { name: 'alpha', description: '内置版', path: '/builtin/alpha' },
        { name: 'builtin-only', description: '只有内置', path: '/builtin/builtin-only' },
      ],
    },
  })
}

describe('SkillsPort 三层合并视图', () => {
  it('show 从当前 executable 资源根读取正文和文件，不把安装 current 当内容', async () => {
    const installed = await makeSource('executable-view', '安装元数据')
    const currentResources = path.join(sourceRoot, 'current-executable-view')
    await mkdir(path.join(currentResources, 'references'), { recursive: true })
    await writeFile(path.join(currentResources, 'SKILL.md'), [
      '---',
      'name: executable-view',
      'type: browser',
      'description: 当前正文',
      '---',
      '',
      '# Current executable body',
      '',
    ].join('\n'), 'utf8')
    await writeFile(path.join(currentResources, 'references', 'details.md'), 'current details\n', 'utf8')
    const port = createSkillsPort({
      runtime: { getResourceRoot: () => currentResources },
    })
    await port.install({ source: installed })

    const detail = await port.show('executable-view')

    expect(detail.body).toContain('# Current executable body')
    expect(detail.files).toContain('references/details.md')
  })

  it('CLI 无 Runtime 时也从 executable current 指向的 build 读取正文和 references', async () => {
    const name = 'cli-executable-view'
    const hash = 'a'.repeat(64)
    const installedDir = globalSkillDir('browser', name)
    const resourceRoot = path.join(globalSkillsRoot(), '.build', name, hash, 'module')
    await mkdir(path.join(resourceRoot, 'references'), { recursive: true })
    await mkdir(installedDir, { recursive: true })
    await writeFile(path.join(installedDir, 'current'), `${hash}\n`, 'utf8')
    await writeFile(path.join(resourceRoot, 'SKILL.md'), [
      '---',
      `name: ${name}`,
      'type: browser',
      'description: CLI 当前正文',
      '---',
      '',
      '# CLI executable body',
      '',
    ].join('\n'), 'utf8')
    await writeFile(path.join(resourceRoot, 'references', 'details.md'), 'CLI details\n', 'utf8')
    await updateRegistry(globalSkillsRoot(), (draft) => {
      draft.skills[name] = {
        name,
        type: 'browser',
        description: 'CLI 当前正文',
        path: installedDir,
        enabled: true,
        executionType: 'executable',
      }
    })

    const detail = await createSkillsPort().show(name)

    expect(detail.body).toContain('# CLI executable body')
    expect(detail.files).toContain('references/details.md')
    expect(detail.files).not.toContain('current')
  })

  it('install/remove/enable/disable 等待统一变化通知', async () => {
    let releaseFirst!: () => void
    const firstNotification = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const onChanged = vi.fn(async () => {
      if (onChanged.mock.calls.length === 1) await firstNotification
    })
    const port = createSkillsPort({ runtime: { onChanged } })

    let installSettled = false
    const install = port.install({ source: await makeSource('event-skill', '变化事件') })
      .finally(() => {
        installSettled = true
      })
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
    expect(installSettled).toBe(false)
    releaseFirst()
    await install

    await port.disable('event-skill')
    await port.enable('event-skill')
    await port.remove('event-skill')
    expect(onChanged).toHaveBeenCalledTimes(4)
  })

  it('同名遮蔽：内置 < 全局 < 项目级，list 每名只出一条', async () => {
    const port = portWithBuiltin()
    await port.install({ source: await makeSource('alpha', '全局版') })
    await port.install({
      source: await makeSource('alpha', '项目版'),
      scope: 'project',
      workspace,
    })

    const items = await port.list({ scope: 'all', workspaces: [workspace] })
    const alpha = items.filter((i) => i.name === 'alpha')
    expect(alpha).toHaveLength(1)
    expect(alpha[0].scope).toBe('project')
    expect(alpha[0].description).toBe('项目版')
    expect(items.find((i) => i.name === 'builtin-only')?.scope).toBe('builtin')
  })

  it('两层遮蔽：全局覆盖内置；不传 workspaces 时项目层不参与', async () => {
    const port = portWithBuiltin()
    await port.install({ source: await makeSource('alpha', '全局版') })

    const items = await port.list({ scope: 'all' })
    const alpha = items.filter((i) => i.name === 'alpha')
    expect(alpha).toHaveLength(1)
    expect(alpha[0].scope).toBe('user')
    expect(alpha[0].description).toBe('全局版')
  })

  it('scope 过滤：builtin 只列内置原貌，project 只列项目副本', async () => {
    const port = portWithBuiltin()
    await port.install({ source: await makeSource('alpha', '全局版') })
    await port.install({
      source: await makeSource('alpha', '项目版'),
      scope: 'project',
      workspace,
    })

    const builtinOnly = await port.list({ scope: 'builtin' })
    expect(builtinOnly.map((i) => i.name).sort()).toEqual(['alpha', 'builtin-only'])
    expect(builtinOnly.every((i) => i.scope === 'builtin')).toBe(true)

    const projectOnly = await port.list({ scope: 'project', workspaces: [workspace] })
    expect(projectOnly.map((i) => i.name)).toEqual(['alpha'])
    expect(projectOnly[0].description).toBe('项目版')
  })
})
