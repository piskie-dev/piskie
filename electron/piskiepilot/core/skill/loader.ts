import { access, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseSkillManifest } from '../../../skills/manifest/parse.js';
import { toImportPath } from '../utils/path.js';
import {
  assertDefinedSkill,
  attachSkillProvenance,
  type DefinedSkill,
  type LoadedSkillModule,
  type SkillDomain,
  type SkillFunctions,
  type SkillProvenance,
} from './define.js';
import type { SkillType } from '@shared/types/skill.js';
import { writeExecutableSkillShim } from '../../../skills/executable/host-shim.js';

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Product discovery classification only; never use this list for trust or entryPoint. */
export const CORE_SKILLS = [
  'browser',
] as const;

export interface SkillSummary {
  name: string;
  type?: SkillType;
  description: string;
  version?: string;
}

export type SkillRoot = Readonly<{
  dir: string;
  trust: 'builtin' | 'custom';
  entryPoint: 'direct' | 'skill_call';
}>;

export type BuiltinSkillRoot = SkillRoot & Readonly<{ trust: 'builtin' }>;

export interface SkillLoaderConfig {
  roots: readonly SkillRoot[];
  typeFilter?: SkillType;
}

interface LoadedSkillInfoBase {
  name: string;
  path: string;
  /** Directory containing the SKILL.md and reference files for this loaded version. */
  resourceRoot: string;
  provenance: SkillProvenance;
  summary?: SkillSummary;
  docs?: string;
}

export interface LoadedExecutableSkillInfo extends LoadedSkillInfoBase {
  mode: 'module';
  module: LoadedSkillModule<SkillDomain, SkillFunctions>;
}

export interface LoadedDocOnlySkillInfo extends LoadedSkillInfoBase {
  mode: 'doc-only';
}

export type LoadedSkillInfo = LoadedExecutableSkillInfo | LoadedDocOnlySkillInfo;

/** Loads executable defineSkill modules and SKILL.md-only standard skills. */
export class SkillLoader {
  private readonly skills = new Map<string, LoadedSkillInfo>();

  constructor(private readonly config: SkillLoaderConfig) {
    if (config.roots.length === 0) throw new Error('SkillLoader requires at least one root');
  }

  async loadBuiltinRoot(root: BuiltinSkillRoot): Promise<void> {
    const folders = await readdir(root.dir);

    for (const folder of folders.sort()) {
      if (folder.startsWith('.') || folder === 'node_modules') continue;
      const skillPath = join(root.dir, folder);
      try {
        if (!(await stat(skillPath)).isDirectory()) continue;
      } catch {
        continue;
      }
      await this.loadBuiltinSkill(skillPath, folder, root);
    }
  }

  private async loadBuiltinSkill(
    skillPath: string,
    skillName: string,
    root: BuiltinSkillRoot,
  ): Promise<boolean> {
    const skillModulePath = join(skillPath, 'skill.js');

    if (root.entryPoint === 'direct' && await pathExists(skillModulePath)) {
      return this.loadExecutable(skillPath, skillName, root, skillModulePath);
    }
    if (root.entryPoint === 'skill_call' && await pathExists(join(skillPath, 'SKILL.md'))) {
      return this.loadDocOnlySkill(skillPath, skillName, root);
    }
    console.warn(`Skipped: ${skillName} (no skill.js or SKILL.md)`);
    return false;
  }

  /** Synchronous half of a prevalidated single-Skill publication. */
  publishSkill(info: LoadedSkillInfo): void {
    this.skills.set(info.name, Object.freeze(info));
  }

  /** Read-only validation performed before the publication disk commit. */
  validateSkillPublication(info: LoadedSkillInfo): void {
    this.assertReplacement(this.skills.get(info.name), info);
  }

  private provenanceForPath(skillPath: string): SkillProvenance {
    const root = this.rootForPath(skillPath);
    return Object.freeze({
      root: resolve(root.dir),
      trust: root.trust,
      entryPoint: root.entryPoint,
    });
  }

  async prepareExecutableSkill(input: {
    skillPath: string;
    skillName: string;
    modulePath: string;
    sourcePath?: string;
    root?: SkillRoot;
    definition?: DefinedSkill<SkillDomain, SkillFunctions>;
  }): Promise<LoadedExecutableSkillInfo> {
    const root = input.root ?? this.rootForPath(input.skillPath);
    if (!input.definition && root.entryPoint === 'skill_call') {
      await writeExecutableSkillShim(dirname(dirname(input.modulePath)));
    }
    const definition = input.definition ?? (await import(toImportPath(input.modulePath))).default;
    assertDefinedSkill(definition);
    if (definition.name !== input.skillName) {
      throw new Error(
        `Skill directory ${input.skillName} cannot publish module named ${definition.name}`,
      );
    }
    if (this.config.typeFilter && definition.domain !== this.config.typeFilter) {
      throw new Error(
        `Skill ${input.skillName} domain ${definition.domain} does not match ${this.config.typeFilter}`,
      );
    }
    const provenance: SkillProvenance = Object.freeze({
      root: resolve(root.dir),
      trust: root.trust,
      entryPoint: root.entryPoint,
    });
    const doc = await this.loadSkillDoc(input.sourcePath ?? input.skillPath, input.skillName);
    return Object.freeze({
      name: input.skillName,
      path: input.skillPath,
      resourceRoot: resolve(input.sourcePath ?? input.skillPath),
      mode: 'module' as const,
      provenance,
      module: attachSkillProvenance(definition, provenance),
      summary: doc.summary,
      docs: doc.docs,
    });
  }

  async prepareDocOnlySkill(input: {
    skillPath: string;
    skillName: string;
    sourcePath?: string;
    root?: SkillRoot;
  }): Promise<LoadedDocOnlySkillInfo> {
    const root = input.root ?? this.rootForPath(input.skillPath);
    if (root.entryPoint === 'direct') {
      throw new Error('builtin executable roots require skill.js');
    }
    const sourcePath = input.sourcePath ?? input.skillPath;
    const doc = await this.loadSkillDoc(sourcePath, input.skillName);
    if (!doc.summary?.name || !doc.summary.description) {
      throw new Error('SKILL.md is missing name or description');
    }
    if (doc.summary.name !== input.skillName) {
      throw new Error(
        `Skill directory ${input.skillName} cannot publish docs named ${doc.summary.name}`,
      );
    }
    if (this.config.typeFilter && doc.summary.type && doc.summary.type !== this.config.typeFilter) {
      throw new Error(
        `Skill ${input.skillName} type ${doc.summary.type} does not match ${this.config.typeFilter}`,
      );
    }
    return Object.freeze({
      name: input.skillName,
      path: input.skillPath,
      resourceRoot: resolve(input.skillPath),
      mode: 'doc-only' as const,
      provenance: this.provenanceForPath(input.skillPath),
      summary: doc.summary,
      docs: doc.docs,
    });
  }

  removeSkill(skillName: string): boolean {
    return this.skills.delete(skillName);
  }

  getSkillInfo(skillName: string): LoadedSkillInfo | undefined {
    return this.skills.get(skillName);
  }

  getAllSkillInfo(): LoadedSkillInfo[] {
    return [...this.skills.values()];
  }

  getExecutableSkills(): LoadedSkillModule<SkillDomain, SkillFunctions>[] {
    return [...this.skills.values()]
      .filter((info): info is LoadedExecutableSkillInfo => info.mode === 'module')
      .map((info) => info.module);
  }

  getSkillModule(skillName: string): LoadedSkillModule<SkillDomain, SkillFunctions> | undefined {
    const info = this.skills.get(skillName);
    return info?.mode === 'module' ? info.module : undefined;
  }

  getSkillResourceRoot(skillName: string): string | undefined {
    return this.skills.get(skillName)?.resourceRoot;
  }

  private async loadExecutable(
    skillPath: string,
    skillName: string,
    root: SkillRoot,
    modulePath: string,
    sourcePath?: string,
  ): Promise<boolean> {
    try {
      const info = await this.prepareExecutableSkill({
        skillPath,
        skillName,
        modulePath,
        sourcePath,
        root,
      });
      this.validateSkillPublication(info);
      this.publishSkill(info);
      console.log(`Loaded executable skill: ${skillName}`);
      return true;
    } catch (error) {
      console.warn(`Skipped: ${skillName} (${error instanceof Error ? error.message : String(error)})`);
      return false;
    }
  }

  private async loadDocOnlySkill(
    skillPath: string,
    skillName: string,
    root: SkillRoot,
  ): Promise<boolean> {
    try {
      const info = await this.prepareDocOnlySkill({ skillPath, skillName, root });
      this.validateSkillPublication(info);
      this.publishSkill(info);
      console.log(`Loaded standard skill: ${skillName}`);
      return true;
    } catch (error) {
      console.warn(`Skipped: ${skillName} (${error instanceof Error ? error.message : String(error)})`);
      return false;
    }
  }

  private assertReplacement(
    existing: LoadedSkillInfo | undefined,
    candidate: LoadedSkillInfo,
  ): void {
    if (!existing) return;
    if (existing.provenance.trust === 'builtin' && candidate.provenance.trust !== 'builtin') {
      throw new Error(`Skill ${candidate.name} is reserved by a built-in loader root`);
    }
    const oldEntry = existing.provenance.entryPoint;
    const newEntry = candidate.provenance.entryPoint;
    if (oldEntry !== newEntry || existing.mode !== candidate.mode) {
      throw new Error(`Skill ${candidate.name} cannot replace a different entry-point class`);
    }
  }

  private rootForPath(skillPath: string): SkillRoot {
    const absolute = resolve(skillPath);
    const root = this.config.roots.find((candidate) => {
      const rootPath = resolve(candidate.dir);
      const child = relative(rootPath, absolute);
      return child === '' || (!child.startsWith('..') && !isAbsolute(child));
    });
    if (!root) throw new Error(`No configured provenance root for ${skillPath}`);
    return root;
  }

  private async loadSkillDoc(
    skillPath: string,
    skillName: string,
  ): Promise<{ summary?: SkillSummary; docs?: string }> {
    const path = join(skillPath, 'SKILL.md');
    try {
      if (!await pathExists(path)) return {};
      const docs = await readFile(path, 'utf8');
      // 加载期容忍投影：manifest 解析失败仍返回全文供 load_skill 使用
      const parsed = parseSkillManifest(docs);
      if (!parsed.manifest) return { docs };
      return {
        docs,
        summary: {
          name: parsed.manifest.name || skillName,
          type: parsed.manifest.type,
          description: parsed.manifest.description ?? '',
          version: parsed.manifest.version,
        },
      };
    } catch (error) {
      console.warn(`Failed to load SKILL.md for ${skillName}: ${String(error)}`);
      return {};
    }
  }
}
