/**
 * 技能教学包渲染器
 *
 * 同一渲染器喂两个出口：
 * - load_skill 工具结果（运行中按需加载，进 messages）
 * - worker 出生时的 L4 技能注入（系统提示词）
 *
 * 三段固定结构：SKILL.md 全文 + 按形态分支的调用入口（函数签名从 zod schema
 * 实时渲染，永不与实现失同步）+ 技能目录文件清单（可直接 read 的绝对路径，≤50 条）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { z } from 'zod'

import { skillToolName } from '../../piskiepilot/core/skill/define.js'
import { toApiSchema } from '../../tools/params.js'

/** 文件清单上限（超出截断并注明，深层内容仍可 read） */
const MAX_LISTED_FILES = 50

/**
 * 裁剪 SKILL.md 中 prompt-omit 标记的区块（函数列表等）。
 * 仅用于 AI 可见出口——函数接口以工具 schema 为唯一权威。
 */
export function stripPromptOmitSections(docs: string): string {
  return docs
    .replace(/<!--\s*prompt-omit:start[^>]*-->[\s\S]*?<!--\s*prompt-omit:end\s*-->\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
}

/** 渲染器对运行时的窄依赖（app 侧由 SkillCatalogPort 满足） */
export interface SkillTeachingPort {
  getLoadedSkillModule(skillName: string): {
    functions: Record<string, { description: string; params: z.ZodType }>
    provenance: { entryPoint: string }
  } | undefined
  classifySkill(skillName: string): Promise<'standard' | 'disabled' | 'unknown'>
  getSkillDocs(skillName: string): Promise<string>
  getSkillResourceRoot(skillName: string): string | undefined
}

export interface SkillTeachingDoc {
  found: boolean
  content: string
  classification?: 'standard' | 'disabled' | 'unknown'
}

/** 渲染指定技能的完整教学包（loader 视图：内置 + 全局已装载） */
export async function renderSkillTeachingDoc(
  port: SkillTeachingPort,
  skillName: string,
  _opts?: { forPrompt?: boolean },
): Promise<SkillTeachingDoc> {
  const classification = await port.classifySkill(skillName)
  if (classification === 'disabled') {
    return { found: false, content: '', classification }
  }

  const module = port.getLoadedSkillModule(skillName)
  const [rawDocs, files] = await Promise.all([
    loadDocs(port, skillName),
    listSkillFiles(port, skillName),
  ])
  const functions = module
    ? Object.entries(module.functions).map(([name, fn]) => ({
        name,
        description: fn.description,
        params: fn.params,
      }))
    : []
  const docs = stripPromptOmitSections(stripFrontmatterBody(rawDocs)).trim()

  if (!docs && functions.length === 0) {
    return { found: false, content: '', classification }
  }

  const parts: string[] = []
  if (docs) parts.push(docs.trimEnd())

  if (functions.length > 0) {
    const direct = module?.provenance.entryPoint === 'direct'
    const lines = ['## 可调用函数（系统实时渲染）', '']
    for (const fn of functions) {
      const desc = firstLine(fn.description)
      const signature = renderSignature(fn.params)
      const call = direct
        ? `${skillToolName(skillName, fn.name)}(${signature})`
        : `${fn.name}(${signature})`
      lines.push(`- \`${call}\`${desc ? ` — ${desc}` : ''}`)
      lines.push(...renderParameterDetails(fn.params).map((line) => `  ${line}`))
    }
    lines.push('', '带 * 为必填参数。')
    lines.push(
      direct
        ? '调用方式：以上函数已直注为工具，直接调用。'
        : `调用方式：\`skill_call({ skill: ${JSON.stringify(skillName)}, function: "函数名", args: { ... } })\`。`,
    )
    parts.push(lines.join('\n'))
  } else if (classification === 'standard') {
    parts.push(knowledgeExecutionSection())
  }

  if (files.length > 0) {
    parts.push(renderFileSection(files))
  }

  return { found: true, content: parts.join('\n\n'), classification }
}

/** Render a process-local executable candidate without publishing it to managed inventory. */
export async function renderCandidateSkillTeaching(input: {
  skillName: string
  resourceRoot: string
  module: {
    functions: Record<string, { description: string; params: z.ZodType }>
    provenance: { entryPoint: string }
  }
}): Promise<string> {
  const rawDocs = await fs.readFile(path.join(input.resourceRoot, 'SKILL.md'), 'utf8')
  const docs = stripPromptOmitSections(stripFrontmatterBody(rawDocs)).trim()
  const parts: string[] = []
  if (docs) parts.push(docs)
  const lines = ['## 可调用函数（系统实时渲染）', '']
  for (const [name, fn] of Object.entries(input.module.functions)) {
    const desc = firstLine(fn.description)
    lines.push(`- \`${name}(${renderSignature(fn.params)})\`${desc ? ` — ${desc}` : ''}`)
    lines.push(...renderParameterDetails(fn.params).map((line) => `  ${line}`))
  }
  lines.push('', '带 * 为必填参数。')
  lines.push(
    `调用方式：\`skill_call({ skill: ${JSON.stringify(input.skillName)}, function: "函数名", args: { ... } })\`。`,
  )
  parts.push(lines.join('\n'))
  return parts.join('\n\n')
}

/** 从目录直接渲染教学包（项目级知识型技能：不进 loader，发现即用） */
export async function renderSkillTeachingFromDir(skillDir: string): Promise<SkillTeachingDoc> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')
  } catch {
    return { found: false, content: '' }
  }
  const docs = stripPromptOmitSections(stripFrontmatterBody(raw)).trim()
  if (!docs) return { found: false, content: '' }

  const files: string[] = []
  await walkDir(skillDir, skillDir, files)
  files.sort()

  const parts = [docs, knowledgeExecutionSection()]
  if (files.length > 0) {
    parts.push(renderFileSection(capFiles(
      files.map((file) => path.resolve(skillDir, file)),
      skillDir,
    )))
  }
  return { found: true, content: parts.join('\n\n'), classification: 'standard' }
}

function knowledgeExecutionSection(): string {
  return [
    '## 执行方式',
    '',
    '本技能无注册函数；按 SKILL.md 指引用通用工具执行：`scripts/` 下脚本经 `shell` 运行，',
    '深层文档按下方文件清单用 `read` 读取。不要调用 `skill_call`。',
  ].join('\n')
}

function renderFileSection(files: string[]): string {
  return [
    '## 技能目录文件清单（绝对路径，深层文档按需 read）',
    '',
    ...files.map((f) => `- ${f}`),
  ].join('\n')
}

async function loadDocs(port: SkillTeachingPort, skillName: string): Promise<string> {
  try {
    return (await port.getSkillDocs(skillName)).trim()
  } catch {
    return ''
  }
}

function renderSignature(params: z.ZodType): string {
  const visible = toApiSchema(params)
  const properties = (visible.properties ?? {}) as Record<string, unknown>
  const required = new Set((visible.required ?? []) as string[])
  return Object.keys(properties)
    .map((name) => (required.has(name) ? `${name}*` : name))
    .join(', ')
}

function renderParameterDetails(params: z.ZodType): string[] {
  const visible = toApiSchema(params) as JsonSchema
  const properties = (visible.properties ?? {}) as Record<string, JsonSchema>
  const required = new Set((visible.required ?? []) as string[])
  return Object.entries(properties).map(([name, schema]) => (
    `- \`${name}${required.has(name) ? '*' : ''}\`: ${renderSchema(schema)}`
  ))
}

type JsonSchema = Record<string, unknown>

function renderSchema(input: JsonSchema): string {
  const schema = unwrapSchema(input)
  const parts = [schemaType(schema)]
  if ('const' in schema) parts.push(`固定值 ${formatLiteral(schema.const)}`)
  if ('default' in schema) parts.push(`默认 ${formatLiteral(schema.default)}`)
  if (typeof schema.format === 'string') parts.push(`格式 ${schema.format}`)
  if (typeof schema.pattern === 'string') parts.push(`匹配 /${schema.pattern}/`)
  if (typeof schema.minLength === 'number') parts.push(`最短 ${schema.minLength}`)
  if (typeof schema.maxLength === 'number') parts.push(`最长 ${schema.maxLength}`)
  if (typeof schema.minimum === 'number') parts.push(`最小 ${schema.minimum}`)
  if (typeof schema.maximum === 'number') parts.push(`最大 ${schema.maximum}`)
  if (typeof schema.minItems === 'number') parts.push(`至少 ${schema.minItems} 项`)
  if (typeof schema.maxItems === 'number') parts.push(`至多 ${schema.maxItems} 项`)
  if (typeof schema.description === 'string' && schema.description.trim()) {
    parts.push(schema.description.trim())
  }
  return parts.join('；')
}

function unwrapSchema(schema: JsonSchema): JsonSchema {
  const alternatives = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined
  if (!alternatives?.length) return schema
  const nonNull = alternatives.filter((candidate) => candidate.type !== 'null')
  return nonNull.length === 1 ? { ...schema, ...nonNull[0] } : schema
}

function schemaType(schema: JsonSchema): string {
  if (Array.isArray(schema.enum)) {
    const base = schema.enum.every((value) => typeof value === 'string') ? 'string' : 'enum'
    return `${base} (${schema.enum.map(formatLiteral).join(' | ')})`
  }
  if (schema.type === 'array') {
    return `array<${renderSchema((schema.items ?? {}) as JsonSchema)}>`
  }
  if (schema.type === 'object') {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
    const required = new Set((schema.required ?? []) as string[])
    if (Object.keys(properties).length === 0 && schema.additionalProperties) {
      return schema.additionalProperties === true
        ? 'record<string, unknown>'
        : `record<string, ${renderSchema(schema.additionalProperties as JsonSchema)}>`
    }
    const fields = Object.entries(properties).map(([name, child]) => (
      `${name}${required.has(name) ? '' : '?'}: ${renderSchema(child)}`
    ))
    return `{ ${fields.join('; ')} }`
  }
  if (typeof schema.type === 'string') return schema.type
  const alternatives = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined
  if (alternatives?.length) return alternatives.map((candidate) => renderSchema(candidate)).join(' | ')
  return 'unknown'
}

function formatLiteral(value: unknown): string {
  return JSON.stringify(value)
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n')[0].trim()
}

/** SKILL.md 原文渲染时剥去 frontmatter（正文才是教学内容） */
function stripFrontmatterBody(source: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  return match ? source.slice(match[0].length) : source
}

/** List files from the resource root that supplied this exact loaded Skill version. */
async function listSkillFiles(port: SkillTeachingPort, skillName: string): Promise<string[]> {
  const skillDir = port.getSkillResourceRoot(skillName)
  if (!skillDir) return []
  return listFilesFromDir(skillDir)
}

async function listFilesFromDir(skillDir: string): Promise<string[]> {
  try {
    if (!(await fs.stat(skillDir)).isDirectory()) return []
  } catch {
    return []
  }

  const files: string[] = []
  await walkDir(skillDir, skillDir, files)
  files.sort()
  return capFiles(files.map((file) => path.resolve(skillDir, file)), skillDir)
}

function capFiles(files: string[], skillDir: string): string[] {
  if (files.length <= MAX_LISTED_FILES) return files
  const dropped = files.length - MAX_LISTED_FILES
  return [...files.slice(0, MAX_LISTED_FILES), `…（另有 ${dropped} 个文件，用 ls 查看 ${skillDir}）`]
}

async function walkDir(root: string, dir: string, out: string[]): Promise<void> {
  if (out.length > MAX_LISTED_FILES * 2) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDir(root, full, out)
    } else {
      out.push(path.relative(root, full))
    }
  }
}
