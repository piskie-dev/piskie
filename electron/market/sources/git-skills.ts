import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { MarketEntry, MarketSource } from '@shared/types/market.js'

import { parseSkillManifest } from '../../skills/manifest/parse.js'

const IGNORED = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.piskie'])
const SOURCE_SCAFFOLDING = new Map<string, ReadonlySet<string>>([
  ['anthropics-skills', new Set(['template'])],
])
const SOURCE_EXCLUDED_PATHS = new Map<string, ReadonlySet<string>>([
  // OpenAI's .system skills target the Codex host rather than Piskie's runtime.
  ['openai-skills', new Set(['skills/.system'])],
])
const MAX_SCAN_DEPTH = 6
const MAX_ENTRIES = 5_000

export function filterGitSkillsSourceWarnings(
  source: Pick<MarketSource, 'id'>,
  warnings: readonly string[],
): string[] {
  const scaffolding = SOURCE_SCAFFOLDING.get(source.id)
  const excluded = SOURCE_EXCLUDED_PATHS.get(source.id)
  return warnings.filter((warning) => (
    ![...(scaffolding ?? [])].some((relative) => warning.startsWith(`${relative}/SKILL.md 校验失败`))
    && ![...(excluded ?? [])].some((relative) => warning === relative || warning.startsWith(`${relative}/`))
  ))
}

export function filterGitSkillsSourceEntries(
  source: Pick<MarketSource, 'id'>,
  entries: readonly MarketEntry[],
): MarketEntry[] {
  const marker = `${source.id}:skill:`
  return entries.filter((entry) => {
    if (entry.kind !== 'skill' || entry.sourceId !== source.id || !entry.id.startsWith(marker)) return true
    return !sourcePathIsExcluded(source, entry.id.slice(marker.length))
  })
}

export async function scanGitSkillsSource(
  source: MarketSource,
  checkout: string,
): Promise<{ entries: MarketEntry[]; warnings: string[] }> {
  const manifests: string[] = []
  await findManifests(checkout, checkout, manifests, 0)
  const entries: MarketEntry[] = []
  const warnings: string[] = []
  for (const manifestFile of manifests.slice(0, MAX_ENTRIES)) {
    const directory = path.dirname(manifestFile)
    const relative = path.relative(checkout, directory).split(path.sep).join('/')
    if (sourcePathIsExcluded(source, relative)) continue
    if (SOURCE_SCAFFOLDING.get(source.id)?.has(relative)) continue
    try {
      const parsed = parseSkillManifest(await fs.readFile(manifestFile, 'utf8'), {
        directoryName: path.basename(directory),
      })
      if (!parsed.manifest || parsed.issues.length > 0) {
        warnings.push(`${relative || '.'}/SKILL.md 校验失败，已跳过：${parsed.issues.map((item) => item.message).join('; ')}`)
        continue
      }
      const executable = await exists(path.join(directory, 'skill.ts'))
      const maturity = relative.split('/').includes('.curated')
        ? 'curated'
        : relative.split('/').includes('.experimental')
          ? 'experimental'
          : 'community'
      entries.push({
        id: `${source.id}:skill:${relative}`,
        kind: 'skill',
        name: parsed.manifest.name,
        description: parsed.manifest.description,
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.url,
        installSource: directory,
        version: parsed.manifest.version,
        license: parsed.manifest.license,
        executable,
        maturity,
        projectedTokens: Math.ceil((parsed.manifest.name.length + parsed.manifest.description.length + relative.length + 16) / 4),
      })
      warnings.push(...parsed.warnings.map((warning) => `${relative}: ${warning}`))
    } catch (error) {
      warnings.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (manifests.length > MAX_ENTRIES) {
    warnings.push(`源 ${source.name} 含 ${manifests.length} 个技能，仅物化前 ${MAX_ENTRIES} 个`)
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { entries, warnings }
}

function sourcePathIsExcluded(source: Pick<MarketSource, 'id'>, relative: string): boolean {
  return [...(SOURCE_EXCLUDED_PATHS.get(source.id) ?? [])].some((prefix) => (
    relative === prefix || relative.startsWith(`${prefix}/`)
  ))
}

async function findManifests(
  root: string,
  current: string,
  output: string[],
  depth: number,
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH || output.length >= MAX_ENTRIES + 1) return
  let entries
  try {
    entries = await fs.readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
    output.push(path.join(current, 'SKILL.md'))
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || IGNORED.has(entry.name)) continue
    const child = path.join(current, entry.name)
    const relative = path.relative(root, child)
    if (relative.split(path.sep).some((part) => IGNORED.has(part))) continue
    await findManifests(root, child, output, depth + 1)
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
