import { describe, expect, it } from 'vitest'

import { parseSkillManifest } from '../parse'

function doc(frontmatter: string, body = '# 正文'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`
}

describe('parseSkillManifest', () => {
  it('最小合法 manifest：name + description', () => {
    const result = parseSkillManifest(doc('name: pdf-tools\ndescription: 处理 PDF'))
    expect(result.issues).toEqual([])
    expect(result.manifest).toMatchObject({ name: 'pdf-tools', description: '处理 PDF' })
    expect(result.body).toBe('# 正文')
    expect(result.repaired).toBe(false)
  })

  it('识别并保存 license/compatibility/metadata/allowed-tools', () => {
    const result = parseSkillManifest(
      doc(
        [
          'name: pdf-tools',
          'description: 处理 PDF',
          'version: 2.1.0',
          'license: MIT',
          'compatibility: 需要 Python 3.9+',
          'metadata:',
          '  homepage: https://example.dev',
          'allowed-tools:',
          '  - Bash',
          '  - Read',
        ].join('\n'),
      ),
    )
    expect(result.issues).toEqual([])
    expect(result.manifest).toMatchObject({
      version: '2.1.0',
      license: 'MIT',
      compatibility: '需要 Python 3.9+',
      metadata: { homepage: 'https://example.dev' },
      allowedTools: ['Bash', 'Read'],
    })
  })

  it('缺 name / 缺 description 分别报必填', () => {
    const noName = parseSkillManifest(doc('description: x'))
    expect(noName.issues.map((i) => i.code)).toContain('NAME_MISSING')
    expect(noName.manifest).toBeUndefined()

    const noDesc = parseSkillManifest(doc('name: pdf-tools'))
    expect(noDesc.issues.map((i) => i.code)).toContain('DESCRIPTION_MISSING')
    expect(noDesc.manifest?.name).toBe('pdf-tools')
  })

  it('name 与目录名不一致为 error（规范升级，非 warning）', () => {
    const result = parseSkillManifest(doc('name: pdf-tools\ndescription: x'), {
      directoryName: 'pdf-utils',
    })
    expect(result.issues.map((i) => i.code)).toContain('NAME_INVALID')
    expect(result.issues.find((i) => i.code === 'NAME_INVALID')?.message).toContain('pdf-utils')
  })

  it('name 规则校验（大写/连字符边界）', () => {
    const result = parseSkillManifest(doc('name: PDF--tools-\ndescription: x'))
    const codes = result.issues.filter((i) => i.code === 'NAME_INVALID')
    expect(codes.length).toBeGreaterThanOrEqual(2)
  })

  it('type 可选，非法值报 TYPE_INVALID', () => {
    const ok = parseSkillManifest(doc('name: a\ndescription: x\ntype: browser'))
    expect(ok.manifest?.type).toBe('browser')

    const bad = parseSkillManifest(doc('name: a\ndescription: x\ntype: desktop'))
    expect(bad.issues.map((i) => i.code)).toContain('TYPE_INVALID')
  })

  it('未加引号含冒号的 description 触发容错修复并记 warning', () => {
    const result = parseSkillManifest(doc('name: aws-kit\ndescription: Build for AWS: ECS'))
    expect(result.issues).toEqual([])
    expect(result.repaired).toBe(true)
    expect(result.manifest?.description).toBe('Build for AWS: ECS')
    expect(result.warnings.some((w) => w.includes('容错修复'))).toBe(true)
  })

  it('compatibility 结构化数组 → systemDependencies（交 sidecar），不进 manifest', () => {
    const result = parseSkillManifest(
      doc(
        [
          'name: media-kit',
          'description: x',
          'compatibility:',
          '  - ffmpeg',
          '  - name: imagemagick',
          '    required: false',
          '    install:',
          '      brew: brew install imagemagick',
        ].join('\n'),
      ),
    )
    expect(result.manifest?.compatibility).toBeUndefined()
    expect(result.systemDependencies).toEqual([
      { name: 'ffmpeg', required: true, install: {} },
      { name: 'imagemagick', required: false, install: { brew: 'brew install imagemagick' } },
    ])
    expect(result.warnings.some((w) => w.includes('sidecar'))).toBe(true)
  })

  it('runtime 生态兼容字段保留', () => {
    const result = parseSkillManifest(
      doc(
        [
          'name: solid-kit',
          'description: x',
          'runtime:',
          '  node: ">=18"',
        ].join('\n'),
      ),
    )
    expect(result.manifest?.runtime).toEqual({ python: undefined, node: '>=18' })
  })

  it('无 frontmatter → FRONTMATTER_MISSING，正文原样返回', () => {
    const result = parseSkillManifest('# 只有正文\n内容')
    expect(result.issues[0].code).toBe('FRONTMATTER_MISSING')
    expect(result.body).toBe('# 只有正文\n内容')
  })

  it('frontmatter 不可修复 → FRONTMATTER_INVALID', () => {
    const result = parseSkillManifest(doc('items:\n  - [unclosed'))
    expect(result.issues[0].code).toBe('FRONTMATTER_INVALID')
    expect(result.manifest).toBeUndefined()
  })

  it('frontmatter 是数组而非映射 → FRONTMATTER_INVALID', () => {
    const result = parseSkillManifest(doc('- a\n- b'))
    expect(result.issues[0].code).toBe('FRONTMATTER_INVALID')
  })

  it('CRLF 文档解析正常', () => {
    const result = parseSkillManifest('---\r\nname: a\r\ndescription: x\r\n---\r\n\r\n正文\r\n')
    expect(result.issues).toEqual([])
    expect(result.body).toBe('正文')
  })

})
