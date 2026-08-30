import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { SkillSidecarMeta } from '@shared/types/skill.js'

/**
 * `.skill-meta.json` sidecar 读写：安装器推断结果的唯一系统写入点。
 * SKILL.md 永不被系统改写；损坏的 sidecar 按缺失处理（重装可再生，不阻断加载）。
 */
export const SIDECAR_FILE = '.skill-meta.json'

export async function readSidecar(skillDir: string): Promise<SkillSidecarMeta | null> {
  try {
    const text = await fs.readFile(path.join(skillDir, SIDECAR_FILE), 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as SkillSidecarMeta
  } catch {
    return null
  }
}

export async function writeSidecar(skillDir: string, meta: SkillSidecarMeta): Promise<void> {
  const file = path.join(skillDir, SIDECAR_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/** 读-合-写：只覆盖 patch 里出现的键，保留既有字段（如 runtimeSetup） */
export async function mergeSidecar(
  skillDir: string,
  patch: Partial<SkillSidecarMeta>,
): Promise<SkillSidecarMeta> {
  const current = (await readSidecar(skillDir)) ?? {}
  const next = { ...current, ...patch }
  await writeSidecar(skillDir, next)
  return next
}
