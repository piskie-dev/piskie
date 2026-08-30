import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  parsePluginManifest,
  readPluginManifestFromDir,
  SUPPORTED_PLUGIN_SCHEMAS,
  validatePluginName,
} from '../manifest'

const VALID_SCHEMA = SUPPORTED_PLUGIN_SCHEMAS[0]
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { $schema: VALID_SCHEMA, name: 'jira-kit', ...overrides }
}

describe('parsePluginManifest', () => {
  it('最小合法 manifest 解析成功', () => {
    const result = parsePluginManifest(base())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.name).toBe('jira-kit')
      expect(result.warnings).toEqual([])
    }
  })

  it('十字段全量解析', () => {
    const result = parsePluginManifest(
      base({
        version: '1.2.0',
        description: 'Jira 套件',
        author: { name: 'Acme', email: 'a@b.c', url: 'https://acme.dev' },
        homepage: 'https://acme.dev/jira-kit',
        repository: 'https://github.com/acme/jira-kit',
        license: 'MIT',
        keywords: ['jira', 'issue'],
        extensions: { 'com.piskie': {} },
      }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.version).toBe('1.2.0')
      expect(result.manifest.author).toEqual({ name: 'Acme', email: 'a@b.c', url: 'https://acme.dev' })
      expect(result.manifest.keywords).toEqual(['jira', 'issue'])
      expect(result.manifest.extensions).toEqual({ 'com.piskie': {} })
    }
  })

  it('拒绝 additionalProperties；宿主字段必须先经显式 adapter', () => {
    const result = parsePluginManifest(base({ hooks: {}, apps: [], interface: { x: 1 } }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message)).toEqual([
        'plugin.json 不允许字段 "hooks"',
        'plugin.json 不允许字段 "apps"',
        'plugin.json 不允许字段 "interface"',
      ])
    }
  })

  it('$schema 是 Agent Plugins 前缀但版本不支持 → SCHEMA_UNSUPPORTED 并列出受支持清单', () => {
    const result = parsePluginManifest(base({ $schema: 'https://agent-plugins.org/schemas/9.9.9/plugin.schema.json' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues[0].code).toBe('SCHEMA_UNSUPPORTED')
      expect(result.issues[0].message).toContain(VALID_SCHEMA)
    }
  })

  it('$schema 根本不是该前缀 → SCHEMA_NOT_AGENT_PLUGINS', () => {
    const result = parsePluginManifest(base({ $schema: 'https://json-schema.org/draft-07/schema' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0].code).toBe('SCHEMA_NOT_AGENT_PLUGINS')
  })

  it('缺 $schema / 缺 name 分别报必填', () => {
    const noSchema = parsePluginManifest({ name: 'x' })
    expect(!noSchema.ok && noSchema.issues[0].code).toBe('SCHEMA_MISSING')
    const noName = parsePluginManifest({ $schema: VALID_SCHEMA })
    expect(!noName.ok && noName.issues[0].code).toBe('NAME_MISSING')
  })

  it('extensions 非 com.piskie 命名空间忽略+告警', () => {
    const result = parsePluginManifest(
      base({ extensions: { 'com.openai': { apps: [] }, 'com.piskie': { reserved: true } } }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.extensions).toEqual({ 'com.piskie': { reserved: true } })
      expect(result.warnings.some((w) => w.includes('com.openai'))).toBe(true)
    }
  })

  it('所有 schema 字段类型错误都是致命错误', () => {
    for (const invalid of [
      { version: 1 },
      { keywords: ['ok', 1] },
      { author: 'Acme' },
      { author: { name: 1 } },
      { author: { name: 'Acme', extra: true } },
      { extensions: { 'com.piskie': 'bad' } },
      { extensions: { 'com.example': 'bad' } },
      { extensions: 'bad' },
    ]) {
      const result = parsePluginManifest(base(invalid))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.issues.some((issue) => issue.code === 'MANIFEST_INVALID')).toBe(true)
    }
  })

  it('字符串输入按 JSON 解析；坏 JSON → MANIFEST_INVALID', () => {
    const good = parsePluginManifest(JSON.stringify(base()))
    expect(good.ok).toBe(true)
    const bad = parsePluginManifest('{not json')
    expect(!bad.ok && bad.issues[0].code).toBe('MANIFEST_INVALID')
  })

  it('顶层非对象 → MANIFEST_INVALID', () => {
    for (const raw of [null, [], 'plain', 42]) {
      const result = parsePluginManifest(raw as unknown)
      if (typeof raw === 'string') continue
      expect(!result.ok && result.issues[0].code).toBe('MANIFEST_INVALID')
    }
  })

  it('只从根级 plugin.json 加载，不回退到 .codex-plugin/plugin.json', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-plugin-manifest-'))
    roots.push(root)
    await mkdir(path.join(root, '.codex-plugin'))
    await writeFile(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify(base()), 'utf8')
    const missing = await readPluginManifestFromDir(root)
    expect(missing.ok).toBe(false)

    await writeFile(path.join(root, 'plugin.json'), JSON.stringify(base({ name: 'portable' })), 'utf8')
    const portable = await readPluginManifestFromDir(root)
    expect(portable.ok).toBe(true)
    if (portable.ok) expect(portable.manifest.name).toBe('portable')
  })
})

describe('validatePluginName', () => {
  it.each(['jira-kit', 'a', 'x1.y2-z3', 'com.acme.tools'])('合法：%s', (name) => {
    expect(validatePluginName(name)).toBeNull()
  })

  it.each([
    ['a'.repeat(65), '64'],
    ['Has-Upper', '只允许'],
    ['a--b', '连续连字符'],
    ['a..b', '连续点号'],
    ['-lead', '首尾'],
    ['trail.', '首尾'],
  ])('非法：%s', (name, fragment) => {
    expect(validatePluginName(name)).toContain(fragment)
  })
})
