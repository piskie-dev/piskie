import { describe, expect, it } from 'vitest'

import { parseYamlWithRepair, repairScalarFields } from '../repair'

describe('parseYamlWithRepair', () => {
  it('合法 YAML 原样解析，不触发修复', () => {
    const result = parseYamlWithRepair('name: xhs-publisher\ndescription: "a: b"\n')
    expect(result.repaired).toBe(false)
    expect(result.data).toEqual({ name: 'xhs-publisher', description: 'a: b' })
  })

  it('未引号含冒号的 description 修复成功', () => {
    const result = parseYamlWithRepair('name: aws-deploy\ndescription: Build for AWS: ECS and Fargate\n')
    expect(result.repaired).toBe(true)
    expect(result.data).toEqual({
      name: 'aws-deploy',
      description: 'Build for AWS: ECS and Fargate',
    })
  })

  it('多个坏行同时修复', () => {
    const source = [
      'name: multi',
      'description: Usage: run it',
      'compatibility: node: >=18, python: 3.11',
      '',
    ].join('\n')
    const result = parseYamlWithRepair(source)
    expect(result.repaired).toBe(true)
    expect(result.data).toEqual({
      name: 'multi',
      description: 'Usage: run it',
      compatibility: 'node: >=18, python: 3.11',
    })
  })

  it('块标量内容不被改写', () => {
    const source = [
      'name: block',
      'description: |',
      '  first line: with colon',
      '  second line: also',
      'license: MIT',
      '',
    ].join('\n')
    const result = parseYamlWithRepair(source)
    expect(result.repaired).toBe(false)
    expect(result.data).toEqual({
      name: 'block',
      description: 'first line: with colon\nsecond line: also\n',
      license: 'MIT',
    })
  })

  it('CRLF 源修复后保持 CRLF 且解析成功', () => {
    const source = 'name: crlf\r\ndescription: Deploy to: prod\r\n'
    expect(repairScalarFields(source)).toContain('\r\n')
    const result = parseYamlWithRepair(source)
    expect(result.repaired).toBe(true)
    expect(result.data).toEqual({ name: 'crlf', description: 'Deploy to: prod' })
  })

  it('值内含引号被转义后仍能解析', () => {
    const result = parseYamlWithRepair('description: say "hi": twice\n')
    expect(result.repaired).toBe(true)
    expect(result.data).toEqual({ description: 'say "hi": twice' })
  })

  it('无可修复行时返回原始错误', () => {
    const source = 'items:\n  - [unclosed\n'
    const result = parseYamlWithRepair(source)
    expect(result.repaired).toBe(false)
    expect(result.data).toBeUndefined()
    expect(result.error).toBeInstanceOf(Error)
  })

  it('修复了一行但整体仍坏时返回原始错误并标记已尝试修复', () => {
    const source = 'description: a: b\nitems:\n  - [unclosed\n'
    const result = parseYamlWithRepair(source)
    expect(result.repaired).toBe(true)
    expect(result.data).toBeUndefined()
    expect(result.error).toBeInstanceOf(Error)
  })
})

describe('repairScalarFields 跳过规则', () => {
  it.each([
    ['已有双引号', 'description: "a: b"'],
    ['已有单引号', "description: 'a: b'"],
    ['flow 集合', 'metadata: {a: b}'],
    ['锚点', 'value: &anchor foo'],
    ['带行内注释', 'description: a: b # note'],
    ['纯键行', 'metadata:'],
  ])('%s 不动', (_label, line) => {
    expect(repairScalarFields(line)).toBe(line)
  })

  it('块标量后的同级键恢复修复', () => {
    const source = ['description: |', '  raw: kept', 'note: fix: me'].join('\n')
    const repaired = repairScalarFields(source)
    expect(repaired).toContain('  raw: kept')
    expect(repaired).toContain('note: "fix: me"')
  })

  it('列表项与文档分隔线不动', () => {
    const source = ['---', 'tags:', '  - a: b', '---'].join('\n')
    expect(repairScalarFields(source)).toBe(source)
  })
})
