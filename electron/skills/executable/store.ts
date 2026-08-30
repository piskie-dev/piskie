import { createUuid } from '@shared/utils/identifiers.js';

import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getSkillsRootDir } from '../../piskiepilot/paths.js';

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONTENT_HASH = /^[a-f0-9]{64}$/u;

function assertIdentity(skillName: string, hash?: string): void {
  if (!SKILL_NAME.test(skillName)) throw new Error(`Invalid Skill name: ${skillName}`);
  if (hash !== undefined && !CONTENT_HASH.test(hash)) {
    throw new Error(`Invalid Skill content hash: ${hash}`);
  }
}

export class ExecutableSkillStore {
  readonly buildRoot: string;

  constructor(skillsRoot = getSkillsRootDir()) {
    this.buildRoot = path.join(skillsRoot, '.build');
  }

  buildDir(skillName: string, hash: string): string {
    assertIdentity(skillName, hash);
    return path.join(this.buildRoot, skillName, hash);
  }

  async markPublicationCandidate(skillName: string, hash: string): Promise<void> {
    await fs.unlink(path.join(this.buildDir(skillName, hash), '.failed')).catch(() => undefined);
    await fs.writeFile(path.join(this.buildDir(skillName, hash), '.published'), `${hash}\n`, 'utf8');
  }

  async markFailedCandidate(skillName: string, hash: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await fs.writeFile(
      path.join(this.buildDir(skillName, hash), '.failed'),
      `${message}\n`,
      'utf8',
    ).catch(() => undefined);
  }

  async unmarkPublicationCandidate(skillName: string, hash: string): Promise<void> {
    await fs.unlink(path.join(this.buildDir(skillName, hash), '.published')).catch(() => undefined);
  }

  async commitCurrent(installedDir: string, hash: string): Promise<void> {
    assertIdentity(path.basename(installedDir), hash);
    await fs.mkdir(installedDir, { recursive: true });
    const currentPath = path.join(installedDir, 'current');
    const tempPath = path.join(installedDir, `.current.${createUuid()}.tmp`);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(tempPath, 'wx', 0o600);
      await handle.writeFile(`${hash}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tempPath, currentPath);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(tempPath).catch(() => undefined);
    }
  }

  /** Remove only failed candidates; every build ever marked for publication is retained at runtime. */
  async pruneFailedBuilds(skillName: string, keepHash: string): Promise<void> {
    assertIdentity(skillName, keepHash);
    const skillBuildRoot = path.join(this.buildRoot, skillName);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(skillBuildRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === keepHash || !CONTENT_HASH.test(entry.name)) continue;
      try {
        await fs.access(path.join(skillBuildRoot, entry.name, '.failed'));
      } catch {
        continue;
      }
      await fs.rm(path.join(skillBuildRoot, entry.name), { recursive: true, force: true });
    }
  }

  /** Startup has no in-flight calls, so only hashes referenced by current survive. */
  async pruneAtStartup(currentBySkill: ReadonlyMap<string, string>): Promise<void> {
    let skills: Dirent[];
    try {
      skills = await fs.readdir(this.buildRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const skill of skills) {
      if (!skill.isDirectory() || !SKILL_NAME.test(skill.name)) continue;
      const keep = currentBySkill.get(skill.name);
      const skillBuildRoot = path.join(this.buildRoot, skill.name);
      const builds = await fs.readdir(skillBuildRoot, { withFileTypes: true });
      for (const build of builds) {
        if (!build.isDirectory() || build.name === keep) continue;
        await fs.rm(path.join(skillBuildRoot, build.name), { recursive: true, force: true });
      }
    }
  }
}
