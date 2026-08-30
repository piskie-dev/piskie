/** 技能域共享类型唯一源 */

export type SkillScope = 'builtin' | 'user' | 'project'

export type SkillType = 'browser' | 'local'

/** registry.json 条目（全局层记账；内置/项目级无记账） */
export interface SkillRegistryEntry {
  name: string
  type: SkillType
  version?: string
  description?: string
  path: string
  source?: string
  sourceType?: string
  installedAt?: string
  updatedAt?: string
  enabled: boolean
  executionType?: 'guide-only' | 'executable'
  hasSettings?: boolean
  /** 插件成员来源指针：级联卸载/更新按此定位 */
  installedFrom?: { plugin: string; version?: string }
}

export interface SkillRegistryFile {
  version: string
  /** 修订号：所有写者 CAS 递增；旧文件缺省视为 0 */
  revision: number
  skills: Record<string, SkillRegistryEntry>
}

/** 系统依赖声明（sidecar 承载，不进 SKILL.md） */
export interface SkillSystemDependency {
  name: string
  required: boolean
  install: {
    apt?: string
    brew?: string
    choco?: string
    manual?: string
  }
}

/**
 * `.skill-meta.json` sidecar：安装器推断结果的唯一系统写入点，
 * SKILL.md 保持用户/生态原文不动。loader 读取顺序：frontmatter 显式 type > sidecar 推断值。
 */
export interface SkillSidecarMeta {
  installedAt?: string
  source?: string
  sourceType?: string
  installedBy?: string
  checksum?: string
  /** frontmatter 缺省 type 时安装器的推断值 */
  type?: SkillType
  /** type 是否为推断补全（非用户显式声明） */
  autoCompletedType?: boolean
  skillType?: 'guide-only' | 'executable'
  hasSettings?: boolean
  systemDependencies?: SkillSystemDependency[]
  runtimeSetup?: {
    pythonVenv?: boolean
    nodeModules?: boolean
    venvCreatedAt?: string
    nodeModulesInstalledAt?: string
  }
}

/** <available_skills> 清单条目降级档位 */
export type SkillInventoryTier = 'full' | 'trimmed' | 'minimal' | 'omitted'

/**
 * 清单机读 manifest：注入时刻（agent 创建或会话恢复）快照，
 * 是 tool_search 互斥不变量的基准，随 agent 序列化持久化（compaction 不清）。
 */
export interface SkillInventorySnapshot {
  renderedAt: string
  entries: Record<string, {
    tier: SkillInventoryTier
    scope: SkillScope
  }>
}
