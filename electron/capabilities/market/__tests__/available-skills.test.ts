import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillsPort } from '../../../skills/ports.js';

const environment = vi.hoisted(() => ({ skills: undefined as unknown as SkillsPort }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sample-profile', getAppPath: () => '/tmp/sample-app' } }));
vi.mock('../../../core/pilot/pilot-manager.js', () => ({ getAppSkillsPort: () => environment.skills }));

import { CapabilityMarketApplication } from '../capability-market-application.js';
import { createCapabilityMarketController } from '../capability-market-controller.js';
import { CAPABILITY_OPERATIONS } from '../../../../shared/electron-contracts/market.js';
import { createSkillsPort } from '../../../skills/ports.js';
import { setPilotRoot } from '../../../piskiepilot/paths.js';
import { loadSelectedSkills } from '../../../agent/context/selected-skills.js';

let root: string;
let workspace: string;
let profile: string;
let application: CapabilityMarketApplication;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-skill-catalog-'));
  workspace = path.join(root, 'sample project');
  profile = path.join(root, 'sample profile');
  await fs.mkdir(workspace);
  await fs.mkdir(profile);
  setPilotRoot(path.join(root, 'pilot'));
  environment.skills = createSkillsPort({ runtime: {
    listBuiltin: () => [
      { name: 'sample-guide', description: 'Builtin description', path: '/sample/builtin/guide' },
      { name: 'builtin-guide', description: 'Builtin only', path: '/sample/builtin/only' },
    ],
  } });
  application = Object.assign(Object.create(CapabilityMarketApplication.prototype), {
    dependencies: { userDataDirectory: profile },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function guide(directory: string, name: string, description: string) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nComplete ${description}.`);
}
async function installUser(name: string, description: string) {
  const source = path.join(root, 'source', name);
  await guide(source, name, description);
  return environment.skills.install({ source });
}
function teachingCatalog() {
  return {
    listManagedSkills: (filter: Parameters<SkillsPort['list']>[0]) => environment.skills.list(filter),
    getSkillDocs: async () => 'Complete user teaching.',
    getLoadedSkillModule: () => undefined,
    getSkillResourceRoot: () => undefined,
    classifySkill: async () => 'standard' as const,
  };
}

describe('effective composer Skill candidates', () => {
  it('returns the enabled project > user > builtin selection through the market handler', async () => {
    await installUser('sample-guide', 'User description');
    await installUser('disabled-guide', 'Disabled description');
    await environment.skills.disable('disabled-guide');
    await guide(path.join(workspace, '.agents', 'skills', 'sample-guide'), 'sample-guide', 'Project description');
    const operation = createCapabilityMarketController(application).operations
      .find(({ id }) => id === CAPABILITY_OPERATIONS.availableSkills)!;
    const result = await operation.execute({} as never, operation.input.parse([workspace]));
    expect(result).toEqual(expect.arrayContaining([
      { name: 'sample-guide', description: 'Project description', scope: 'project' },
      { name: 'builtin-guide', description: 'Builtin only', scope: 'builtin' },
    ]));
    expect(result).toHaveLength(2);
    const loaded = await loadSelectedSkills(teachingCatalog(), ['sample-guide', 'disabled-guide'], {
      workspace, defaultWorkspaceDir: path.join(profile, 'workspace'),
    });
    expect(loaded.instructions).toContain('Complete Project description.');
    expect(loaded.metadata.skillLoadErrors?.[0].name).toBe('disabled-guide');
    await fs.rm(path.join(workspace, '.agents', 'skills', 'sample-guide'), { recursive: true });
    expect((await application.availableSkills(workspace)).find(({ name }) => name === 'sample-guide')?.scope).toBe('user');
    const changedSource = await loadSelectedSkills(teachingCatalog(), ['sample-guide'], {
      workspace, defaultWorkspaceDir: path.join(profile, 'workspace'),
    });
    expect(changedSource.instructions).toContain('Complete user teaching.');
    expect(changedSource.instructions).not.toContain('Complete Project description.');
  });

  it('uses the default workspace exclusion and observes disabling after selection', async () => {
    await installUser('sample-guide', 'User description');
    const defaultWorkspace = path.join(profile, 'workspace');
    await guide(path.join(defaultWorkspace, '.agents', 'skills', 'sample-guide'), 'sample-guide', 'Default project description');
    for (const selectedWorkspace of [undefined, defaultWorkspace]) {
      expect((await application.availableSkills(selectedWorkspace)).find(({ name }) => name === 'sample-guide'))
        .toEqual({ name: 'sample-guide', description: 'User description', scope: 'user' });
    }
    await environment.skills.disable('sample-guide');
    expect((await application.availableSkills(workspace)).some(({ name }) => name === 'sample-guide')).toBe(false);
    const loaded = await loadSelectedSkills(teachingCatalog(), ['sample-guide'], {
      workspace, defaultWorkspaceDir: defaultWorkspace,
    });
    expect(loaded.metadata.skillLoadErrors).toHaveLength(1);
    expect(loaded.instructions).not.toContain('已完整加载');
  });

  it('returns all enabled candidates independently of prompt inventory budgets', async () => {
    for (let index = 0; index < 90; index++) {
      const name = `sample-guide-${index}`;
      await guide(path.join(workspace, '.agents', 'skills', name), name, 'Sample description '.repeat(60));
    }
    const candidates = await application.availableSkills(workspace);
    expect(candidates).toHaveLength(92);
    expect(candidates.find(({ name }) => name === 'sample-guide-89')?.description).toContain('Sample description');
  });
});
