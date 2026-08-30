import { describe, expect, it } from 'vitest'

import { validateSkillName } from '../name'

describe('validateSkillName', () => {
  it('合法名字零 issue（含目录一致）', () => {
    expect(validateSkillName('xhs-publisher', 'xhs-publisher')).toEqual([])
  })

  it.each([
    ['', 'NAME_EMPTY'],
    ['a'.repeat(65), 'NAME_TOO_LONG'],
    ['Has-Upper', 'NAME_INVALID_CHARS'],
    ['under_score', 'NAME_INVALID_CHARS'],
    ['-lead', 'NAME_HYPHEN_EDGE'],
    ['trail-', 'NAME_HYPHEN_EDGE'],
    ['a--b', 'NAME_HYPHEN_RUN'],
  ])('%s → %s', (name, code) => {
    expect(validateSkillName(name).map((i) => i.code)).toContain(code)
  })

  it('目录名不一致升为 error（规范一致性）', () => {
    expect(validateSkillName('foo', 'bar').map((i) => i.code)).toEqual(['NAME_DIR_MISMATCH'])
  })

  it('未传目录名时不检查一致性', () => {
    expect(validateSkillName('foo')).toEqual([])
  })
})
