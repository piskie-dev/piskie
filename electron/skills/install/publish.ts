import type { SkillType } from '@shared/types/skill.js'

import type { InstallPublishHooks } from './pipeline.js'

/**
 * 内存发布段适配：把运行时发布原语接成安装管线钩子（两段连跑，仅 app 注入）。
 * CLI 进程不注入——其内存发布由 app 的 registry watch 重载路径补齐。
 */
export interface SkillPublishRuntime {
  prepareStandardSkillPublication(input: {
    skillName: string
    type: SkillType
    candidateDir: string
    targetDir: string
  }): Promise<{ commit(): void }>
  prepareExecutableSkillPublication(input: {
    skillName: string
    domain: SkillType
    modulePath: string
    installedDir: string
  }): Promise<{ commit(): void }>
}

export function createInstallPublishHooks(runtime: SkillPublishRuntime): InstallPublishHooks {
  return {
    async prepareKnowledge({ candidateDir, targetDir, name, type }) {
      return runtime.prepareStandardSkillPublication({
        skillName: name,
        type,
        candidateDir,
        targetDir,
      })
    },
    async prepareExecutable({ name, domain, modulePath, installedDir }) {
      return runtime.prepareExecutableSkillPublication({
        skillName: name,
        domain,
        modulePath,
        installedDir,
      })
    },
    commit(handle) {
      if (handle && typeof (handle as { commit?: unknown }).commit === 'function') {
        ;(handle as { commit(): void }).commit()
      }
    },
  }
}
