/**
 * agentskills.io 规范的 name 约束：1-64 字符，小写字母/数字/连字符，
 * 不得以连字符开头/结尾，不得出现连续连字符；且须与技能目录名一致（由调用方传入比对）。
 */
export interface NameIssue {
  code:
    | 'NAME_EMPTY'
    | 'NAME_TOO_LONG'
    | 'NAME_INVALID_CHARS'
    | 'NAME_HYPHEN_EDGE'
    | 'NAME_HYPHEN_RUN'
    | 'NAME_DIR_MISMATCH'
  message: string
}

export function validateSkillName(name: string, directoryName?: string): NameIssue[] {
  const issues: NameIssue[] = []
  if (name.length === 0) {
    issues.push({ code: 'NAME_EMPTY', message: 'name 不能为空' })
    return issues
  }
  if (name.length > 64) {
    issues.push({ code: 'NAME_TOO_LONG', message: `name 超过 64 字符（当前 ${name.length}）` })
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    issues.push({ code: 'NAME_INVALID_CHARS', message: `name 只允许小写字母、数字与连字符：${name}` })
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    issues.push({ code: 'NAME_HYPHEN_EDGE', message: 'name 不得以连字符开头或结尾' })
  }
  if (name.includes('--')) {
    issues.push({ code: 'NAME_HYPHEN_RUN', message: 'name 不得包含连续连字符' })
  }
  if (directoryName !== undefined && directoryName !== name) {
    issues.push({
      code: 'NAME_DIR_MISMATCH',
      message: `name（${name}）须与技能目录名（${directoryName}）一致`,
    })
  }
  return issues
}
