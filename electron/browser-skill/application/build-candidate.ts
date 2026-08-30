import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertDefinedSkill,
  attachSkillProvenance,
  type LoadedSkillModule,
  type SkillFunctions,
} from '../../piskiepilot/core/skill/define.js';
import { validateSkillDir } from '../../skills/install/validate.js';
import {
  compileExecutableSkill,
  type CompiledSkillCandidate,
} from '../../skills/executable/compiler.js';
import { buildLoadedSkillEntries } from '../../tools/skill/domain-descriptors.js';
import type { CatalogEntry } from '../../tools/catalog.js';
import {
  browserSkillCandidateOverlay,
  type BrowserSkillCandidate,
} from '../candidate-overlay.js';

export async function buildBrowserSkillCandidate(input: {
  mainAgentId: string;
  sourceDir: string;
  skillName?: string;
  validateCandidate?: (candidate: BrowserSkillCandidate) => void;
}): Promise<BrowserSkillCandidate> {
  const sourceDir = path.resolve(input.sourceDir);
  const validation = await validateSkillDir(sourceDir, { directoryName: path.basename(sourceDir) });
  if (!validation.ok || !validation.parse.manifest) {
    throw new Error(
      validation.issues
        .filter((issue) => issue.type === 'error')
        .map((issue) => `${issue.field}: ${issue.message}`)
        .join('; ') || 'Invalid Browser Skill source',
    );
  }
  if (validation.executionType !== 'executable') {
    throw new Error('Browser Skill source requires root skill.ts');
  }
  const manifest = validation.parse.manifest;
  const skillName = input.skillName?.trim() || manifest.name;
  if (manifest.name !== skillName) {
    throw new Error(`SKILL.md name ${manifest.name} does not match requested ${skillName}`);
  }
  if (manifest.type !== 'browser') {
    throw new Error('Browser Skill SKILL.md must declare type: browser');
  }

  const compiled = await compileExecutableSkill(sourceDir, skillName, { profile: 'browser' });
  const resourceRoot = compiled.buildDir;
  const imported = await importCandidate(compiled);
  assertDefinedSkill(imported.default);
  if (imported.default.name !== skillName) {
    throw new Error(`skill.ts defines ${imported.default.name}, expected ${skillName}`);
  }
  if (imported.default.domain !== 'browser') {
    throw new Error(`Browser Skill domain must be browser, received ${imported.default.domain}`);
  }

  const provenance = Object.freeze({
    root: resourceRoot,
    trust: 'custom' as const,
    entryPoint: 'skill_call' as const,
  });
  const loaded = attachSkillProvenance(
    imported.default,
    provenance,
  ) as LoadedSkillModule<'browser', SkillFunctions<'browser'>>;
  const entries = buildLoadedSkillEntries(loaded).map((entry) => Object.freeze({
    modelName: entry.tool.def.name,
    tool: entry.tool,
    trust: provenance.trust,
    identity: entry.identity,
  })) as readonly CatalogEntry[];
  const builtAt = new Date().toISOString();
  const candidate: BrowserSkillCandidate = Object.freeze({
    id: `${skillName}:${compiled.hash}`,
    sourceDir,
    resourceRoot,
    skillName,
    loaded,
    entries: Object.freeze(entries),
    builtAt,
  });
  input.validateCandidate?.(candidate);
  browserSkillCandidateOverlay.register(input.mainAgentId, candidate);
  return candidate;
}

export async function assertCandidateSourceCurrent(candidate: BrowserSkillCandidate): Promise<void> {
  const compiled = await compileExecutableSkill(candidate.sourceDir, candidate.skillName, { profile: 'browser' });
  if (path.resolve(compiled.buildDir) !== path.resolve(candidate.resourceRoot)) {
    throw new Error('Source changed after the current build; rebuild and re-run independent validation before publishing');
  }
}

async function importCandidate(candidate: CompiledSkillCandidate): Promise<{ default: unknown }> {
  // Hash-addressed paths are immutable. Query makes retrying a failed import independent of ESM cache.
  const href = `${pathToFileURL(candidate.modulePath).href}?candidate=${candidate.hash}`;
  return await import(href) as { default: unknown };
}
