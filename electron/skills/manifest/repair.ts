import yaml from 'js-yaml'

/**
 * frontmatter 容错解析：先原样解析，失败后逐行给未加引号的标量值加引号重试一次。
 *
 * 第三方技能常写 `description: Build for AWS: ECS` 这类未加引号含冒号的 YAML——
 * 直接解析会报 mapping 错误。修复只处理"键: 裸标量值"形态的行，以下情况一律不动：
 * - 块标量（`|` / `>` 起始）及其缩进内容行
 * - 已有引号（单/双）的值
 * - flow 集合起始（`[` / `{`）、锚点/别名/标签（`&` / `*` / `!`）
 * - 带行内注释的值（无法区分注释与值的一部分，宁可不修）
 * - 纯键行、列表项、文档分隔线
 */
export interface RepairResult {
  data: unknown
  repaired: boolean
  /** 修复被触发但仍解析失败时为原始错误 */
  error?: Error
}

export function parseYamlWithRepair(source: string): RepairResult {
  try {
    return { data: yaml.load(source), repaired: false }
  } catch (firstError) {
    const repairedSource = repairScalarFields(source)
    if (repairedSource === source) {
      return { data: undefined, repaired: false, error: asError(firstError) }
    }
    try {
      return { data: yaml.load(repairedSource), repaired: true }
    } catch {
      return { data: undefined, repaired: true, error: asError(firstError) }
    }
  }
}

const KEY_SCALAR_LINE = /^(\s*)([A-Za-z0-9_][\w.-]*):[ \t]+(.*)$/

export function repairScalarFields(source: string): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const out: string[] = []
  let blockScalarIndent: number | null = null

  for (const line of lines) {
    const indent = line.length - line.trimStart().length

    if (blockScalarIndent !== null) {
      if (line.trim() === '' || indent > blockScalarIndent) {
        out.push(line)
        continue
      }
      blockScalarIndent = null
    }

    const match = KEY_SCALAR_LINE.exec(line)
    if (!match) {
      out.push(line)
      continue
    }

    const [, leading, key, rawValue] = match
    const value = rawValue.trimEnd()

    if (/^[|>]/.test(value)) {
      blockScalarIndent = leading.length
      out.push(line)
      continue
    }

    if (!needsQuoting(value)) {
      out.push(line)
      continue
    }

    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    out.push(`${leading}${key}: "${escaped}"`)
  }

  return out.join(newline)
}

function needsQuoting(value: string): boolean {
  if (value === '') return false
  const first = value[0]
  if (first === '"' || first === "'") return false
  if (first === '[' || first === '{') return false
  if (first === '&' || first === '*' || first === '!') return false
  if (first === '#') return false
  if (/\s#/.test(value)) return false
  // 触发修复的唯一形态：值内含 ": " 或以冒号结尾（YAML 会误读成嵌套 mapping）
  return /:\s/.test(value) || value.endsWith(':')
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}
