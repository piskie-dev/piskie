/**
 * PilotRuntime — Pilot 进程内运行时
 *
 * 直接持有 local/browser SkillLoader 和浏览器生命周期；
 * 技能安装管理面通过 electron/skills/ 的端口接入。
 *
 * registry 只读快照直接复用技能管理域的 CAS 存储；所有写事务归 SkillsPort。
 */
import type {
  SkillRegistryEntry,
  SkillRegistryFile,
  SkillType,
} from '@shared/types/skill.js';
import { getSkillsDirByType, getSkillsRootDir } from '../paths.js';
import type {
  LoadedSkillModule,
  SkillDomain,
  SkillFunctions,
} from '../core/skill/define.js';
import {
  SkillLoader,
  type BuiltinSkillRoot,
  type LoadedSkillInfo,
  type SkillRoot,
} from '../core/skill/loader.js';
import type { ToolCatalog } from '../../tools/catalog.js';
import { buildLoadedSkillEntries } from '../../tools/skill/domain-descriptors.js';
import { ExecutableSkillStore } from '../../skills/executable/store.js';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { emptyRegistry, readRegistry } from '../core/skill/registry-store.js';
import { BrowserManager } from '../browser/core/browser/browser-manager.js';
import { screenStreamHub } from '../browser/screen-hub.js';

const LOCAL_BUILTIN_ROOT: BuiltinSkillRoot = {
  // Source: <repo>/skills; build: <repo>/dist-electron/skills.
  dir: resolve(import.meta.dirname, '../../../skills'),
  trust: 'builtin',
  entryPoint: 'skill_call',
};

const BROWSER_BUILTIN_ROOT: BuiltinSkillRoot = {
  dir: resolve(import.meta.dirname, '../browser/skills'),
  trust: 'builtin',
  entryPoint: 'direct',
};

export interface RuntimeAvailableSkill {
  name: string;
  type: SkillType;
  version: string;
  description: string;
  path: string;
  mode: 'module' | 'doc-only';
}

/** 安装管线内存发布段的两段句柄：prepare 已校验，commit 同步、无 I/O、不可失败 */
export interface PreparedSkillPublication {
  commit(): void;
}

export interface RuntimeBuiltinSkill {
  name: string;
  description: string;
  type: SkillType;
  path: string;
}

export class PilotRuntime {
  private readonly localLoader: SkillLoader;
  private readonly browserLoader: SkillLoader;
  private registry: SkillRegistryFile = emptyRegistry();
  private readonly executableStore = new ExecutableSkillStore();
  private toolCatalog: ToolCatalog | undefined;
  private initialized = false;

  constructor() {
    const localRoots: SkillRoot[] = [LOCAL_BUILTIN_ROOT, {
      dir: getSkillsDirByType('local'),
      trust: 'custom',
      entryPoint: 'skill_call',
    }];
    const browserRoots: SkillRoot[] = [BROWSER_BUILTIN_ROOT, {
      dir: getSkillsDirByType('browser'),
      trust: 'custom',
      entryPoint: 'skill_call',
    }];
    this.localLoader = new SkillLoader({ roots: localRoots, typeFilter: 'local' });
    this.browserLoader = new SkillLoader({ roots: browserRoots, typeFilter: 'browser' });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.reloadInstalledRegistry();
    await this.localLoader.loadBuiltinRoot(LOCAL_BUILTIN_ROOT);
    await BrowserManager.cleanupDeadBrowsers();
    await this.browserLoader.loadBuiltinRoot(BROWSER_BUILTIN_ROOT);
    await this.loadInstalledSkillsAtStartup();
    this.initialized = true;
  }

  bindToolCatalog(catalog: ToolCatalog): void {
    this.toolCatalog = catalog;
  }

  async dispose(): Promise<void> {
    screenStreamHub.close();
    try {
      await BrowserManager.closeAll();
    } finally {
      this.initialized = false;
    }
  }

  getExecutableSkills(): LoadedSkillModule<SkillDomain, SkillFunctions>[] {
    this.ensureInitialized();
    return [
      ...this.localLoader.getExecutableSkills(),
      ...this.browserLoader.getExecutableSkills(),
    ];
  }

  getSkillModule(skillName: string): LoadedSkillModule<SkillDomain, SkillFunctions> | undefined {
    this.ensureInitialized();
    return this.localLoader.getSkillModule(skillName)
      ?? this.browserLoader.getSkillModule(skillName);
  }

  getAvailableSkill(skillName: string): RuntimeAvailableSkill | undefined {
    this.ensureInitialized();
    const local = this.localLoader.getSkillInfo(skillName);
    const type: SkillType = local ? 'local' : 'browser';
    const info = local ?? this.browserLoader.getSkillInfo(skillName);
    if (!info) return undefined;
    return toRuntimeAvailableSkill(info, type);
  }

  // ==================== 技能搜索与文档 ====================

  /** 按名称读取已加载 Skill 的文档包。 */
  async getSkillDocs(skillNames: string[]): Promise<string> {
    this.ensureInitialized();
    const parts: string[] = [];

    for (const skillName of skillNames) {
      const info = this.localLoader.getSkillInfo(skillName)
        ?? this.browserLoader.getSkillInfo(skillName);
      if (!info?.docs?.trim()) continue;
      parts.push(info.docs);
    }

    return parts.join('\n\n---\n\n');
  }

  getSkillResourceRoot(skillName: string): string | undefined {
    this.ensureInitialized();
    return this.localLoader.getSkillResourceRoot(skillName)
      ?? this.browserLoader.getSkillResourceRoot(skillName);
  }

  // ==================== 技能 registry 只读投影 ====================

  private async reloadInstalledRegistry(): Promise<void> {
    this.registry = await readRegistry(getSkillsRootDir());
  }

  private installedForType(type: SkillType): SkillRegistryEntry[] {
    return Object.values(this.registry.skills).filter((entry) => entry.type === type);
  }

  private loaderFor(skillType: SkillType): SkillLoader {
    if (skillType === 'browser') return this.browserLoader;
    return this.localLoader;
  }

  private async loadInstalledSkillsAtStartup(): Promise<void> {
    const currentBySkill = new Map<string, string>();
    for (const type of ['browser', 'local'] as const) {
      const loader = this.loaderFor(type);
      for (const installed of this.installedForType(type)) {
        if (installed.executionType === 'executable') {
          let currentHash: string;
          try {
            currentHash = await this.readCurrentHash(installed);
            currentBySkill.set(installed.name, currentHash);
          } catch (error) {
            if (installed.enabled) this.warnStartupSkip(installed.name, error);
            continue;
          }
          if (!installed.enabled) continue;

          try {
            this.assertCustomPublicationName(installed.name);
            const modulePath = this.executableModulePath(installed.name, currentHash);
            const info = await loader.prepareExecutableSkill({
              skillPath: installed.path,
              sourcePath: dirname(modulePath),
              skillName: installed.name,
              modulePath,
            });
            loader.validateSkillPublication(info);
            loader.publishSkill(info);
          } catch (error) {
            this.warnStartupSkip(installed.name, error);
          }
          continue;
        }

        if (!installed.enabled) continue;
        try {
          this.assertCustomPublicationName(installed.name);
          const info = await loader.prepareDocOnlySkill({
            skillPath: installed.path,
            skillName: installed.name,
          });
          loader.validateSkillPublication(info);
          loader.publishSkill(info);
        } catch (error) {
          this.warnStartupSkip(installed.name, error);
        }
      }
    }
    await this.executableStore.pruneAtStartup(currentBySkill);
  }

  private warnStartupSkip(skillName: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[PilotRuntime] Skipped installed Skill ${skillName}: ${detail}`);
  }

  private async readCurrentHash(entry: SkillRegistryEntry): Promise<string> {
    const hash = (await readFile(resolve(entry.path, 'current'), 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new Error(`invalid current hash for ${entry.name}: ${JSON.stringify(hash)}`);
    }
    return hash;
  }

  private executableModulePath(skillName: string, hash: string): string {
    return resolve(getSkillsRootDir(), '.build', skillName, hash, 'module', 'skill.js');
  }

  getInstalledSkill(skillName: string): SkillRegistryEntry | undefined {
    return this.registry.skills[skillName];
  }

  // ==================== 管理面发布原语（安装管线内存发布段） ====================

  /** 知识型技能的内存发布：prepare 读候选目录并校验，commit 同步发布文档切片 */
  async prepareStandardSkillPublication(input: {
    skillName: string;
    type: SkillType;
    candidateDir: string;
    targetDir: string;
  }): Promise<PreparedSkillPublication> {
    this.ensureInitialized();
    this.assertCustomPublicationName(input.skillName);
    const loader = this.loaderFor(input.type);
    const info = await loader.prepareDocOnlySkill({
      skillPath: input.targetDir,
      sourcePath: input.candidateDir,
      skillName: input.skillName,
    });
    loader.validateSkillPublication(info);
    return {
      commit: () => {
        loader.publishSkill(info);
      },
    };
  }

  /** 可执行技能的内存发布：prepare 导入构建产物并校验工具面替换，commit 同步发布 */
  async prepareExecutableSkillPublication(input: {
    skillName: string;
    domain: SkillType;
    modulePath: string;
    installedDir: string;
  }): Promise<PreparedSkillPublication> {
    this.ensureInitialized();
    const catalog = this.toolCatalog;
    if (!catalog) throw new Error('Process ToolCatalog is not bound');
    this.assertCustomPublicationName(input.skillName);
    const loader = this.loaderFor(input.domain);
    const info = await loader.prepareExecutableSkill({
      skillPath: input.installedDir,
      sourcePath: dirname(input.modulePath),
      skillName: input.skillName,
      modulePath: input.modulePath,
    });
    loader.validateSkillPublication(info);
    const entries = buildLoadedSkillEntries(info.module);
    catalog.validateSkillReplacement(input.skillName, info.provenance, entries);
    return {
      commit: () => {
        loader.publishSkill(info);
        catalog.replaceSkill(input.skillName, info.provenance, entries);
      },
    };
  }

  /**
   * 与盘上 registry 收敛（外部写者感知：CLI 安装/卸载/启停后经 watch 触发）。
   * 逐 type 幂等：已加载但不再启用的自定义技能撤下；启用条目全量重发布。
   */
  async syncWithRegistry(): Promise<void> {
    this.ensureInitialized();
    await this.reloadInstalledRegistry();

    for (const type of ['browser', 'local'] as const) {
      const installed = this.installedForType(type);
      const byName = new Map(installed.map((skill) => [skill.name, skill]));
      const loader = this.loaderFor(type);

      for (const loaded of loader.getAllSkillInfo()) {
        if (loaded.provenance.trust !== 'custom'
          || loaded.provenance.entryPoint !== 'skill_call') continue;
        const entry = byName.get(loaded.name);
        const expectedMode = entry?.executionType === 'executable' ? 'module' : 'doc-only';
        if (entry?.enabled && loaded.mode === expectedMode) continue;
        loader.removeSkill(loaded.name);
        this.toolCatalog?.removeSkill(loaded.name);
      }

      for (const entry of installed) {
        if (!entry.enabled) continue;
        try {
          await this.republishInstalledEntry(type, entry);
        } catch (error) {
          console.warn(`[PilotRuntime] Failed to republish skill ${entry.name} after registry sync:`, error);
        }
      }
    }
  }

  private async republishInstalledEntry(type: SkillType, entry: SkillRegistryEntry): Promise<void> {
    const loader = this.loaderFor(type);
    if (entry.executionType === 'executable') {
      const hash = await this.readCurrentHash(entry);
      const modulePath = this.executableModulePath(entry.name, hash);
      const prepared = await this.prepareExecutableSkillPublication({
        skillName: entry.name,
        domain: type,
        modulePath,
        installedDir: entry.path,
      });
      prepared.commit();
      return;
    }

    const info = await loader.prepareDocOnlySkill({
      skillPath: entry.path,
      skillName: entry.name,
    });
    loader.validateSkillPublication(info);
    loader.publishSkill(info);
  }

  /** 内置技能描述（trust=builtin 的装载根；管理面 list 的 builtin 层数据源） */
  listBuiltinSkills(): RuntimeBuiltinSkill[] {
    this.ensureInitialized();
    const result: RuntimeBuiltinSkill[] = [];
    const seen = new Set<string>();
    const append = (loader: SkillLoader, type: SkillType): void => {
      for (const info of loader.getAllSkillInfo()) {
        if (info.provenance.trust !== 'builtin' || seen.has(info.name)) continue;
        seen.add(info.name);
        result.push({
          name: info.name,
          description: info.summary?.description ?? `Skill: ${info.name}`,
          type,
          path: info.path,
        });
      }
    };
    append(this.localLoader, 'local');
    append(this.browserLoader, 'browser');
    return result;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('PilotRuntime not initialized. Call initialize() first.');
    }
  }

  private assertCustomPublicationName(skillName: string): void {
    for (const loader of [this.localLoader, this.browserLoader]) {
      const existing = loader.getSkillInfo(skillName);
      if (existing?.provenance.trust === 'builtin') {
        throw new Error(`Skill ${skillName} is reserved by a built-in loader root`);
      }
    }
  }

}

function toRuntimeAvailableSkill(
  info: LoadedSkillInfo,
  type: SkillType,
): RuntimeAvailableSkill {
  return {
    name: info.name,
    type,
    version: info.summary?.version ?? '1.0.0',
    description: info.summary?.description ?? `Skill: ${info.name}`,
    path: info.path,
    mode: info.mode,
  };
}
