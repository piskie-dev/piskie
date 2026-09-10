import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/example-profile', getAppPath: () => '/tmp/example-app' },
}));

import { setPilotRoot } from '../../../piskiepilot/paths.js';
import { createSkillsPort } from '../../ports.js';
import { renderAvailableSkillTeaching } from '../teaching.js';
import { buildSkillInventory, createSkillSearchSource } from '../../../core/pilot/skill-inventory.js';
import type { SkillCatalogPort } from '../../../core/pilot/pilot-manager.js';
import { LoadSkillTool } from '../../../tools/skill/load-skill.tool.js';
import type { ToolContext } from '../../../tools/types.js';
import { WorkerRole } from '../../../agent/roles/worker.role.js';
import type { RuntimeOptions } from '../../../agent/roles/role.js';
import type { AgentHost } from '../../../agent/agent-host.js';
import { BrowserModule } from '../../../agent/modules/browser.module.js';
import { ToolContextBuilder } from '../../../agent/tool-context.js';
import { pathsService } from '../../../services/paths.service.js';
import { z } from '../../../tools/params.js';

let root: string;
let workspace: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-skill-source-'));
  workspace = path.join(root, 'sample project');
  setPilotRoot(path.join(root, 'pilot'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeGuide(dir: string, name: string, body: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'references'), { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}`);
  await fs.writeFile(path.join(dir, 'references', 'sample.md'), body);
}

async function sources() {
  const name = 'example-guide';
  const source = path.join(root, 'source', name);
  await writeGuide(source, name, 'Global body.');
  const getResourceRoot = vi.fn<() => string | undefined>();
  const port = createSkillsPort({ runtime: {
    getResourceRoot,
    getFunctionSignatures: () => [{ name: 'globalOnly' }],
  } });
  const globalRoot = (await port.install({ source })).path;
  getResourceRoot.mockReturnValue(globalRoot);
  await writeGuide(source, name, 'Project body.');
  const installed = await port.install({ source, scope: 'project', workspace });
  const catalog = {
    listManagedSkills: (filter) => port.list(filter),
    getSkillResourceRoot: () => globalRoot,
    getSkillDocs: async () => 'Global body.',
    loadSkillDocs: async () => 'Browser core guide.',
    classifySkill: async () => 'standard',
    getLoadedSkillModule: () => ({
      functions: { globalOnly: { description: 'Global function', params: z.object({}) } },
      provenance: { entryPoint: 'skill_call' },
    }),
  } as SkillCatalogPort;
  return { name, port, catalog, installed };
}

describe('project Skill source selection', () => {
  it('uses the installed project body and resources throughout inventory, search, detail and teaching', async () => {
    const { name, port, catalog, installed } = await sources();
    const options = { workspace, defaultWorkspaceDir: pathsService.getDefaultWorkspaceDir() };
    const inventory = await buildSkillInventory(catalog, options);
    const search = await createSkillSearchSource(catalog).listSearchableSkills(workspace);
    const detail = await port.show(name, { workspace });
    const teaching = await renderAvailableSkillTeaching(catalog, name, options);
    const loaded = await new LoadSkillTool(catalog).execute({ skill: name }, {
      agentSpec: 'director', runConfig: { workspace },
    } as ToolContext);

    expect(inventory.text).toContain(path.join(installed.path, 'SKILL.md'));
    expect(inventory.text).not.toContain('globalOnly');
    expect(search).toEqual([expect.objectContaining({
      scope: 'project', path: path.join(installed.path, 'SKILL.md'), body: 'Project body.', functions: [],
    })]);
    expect(detail).toMatchObject({ scope: 'project', body: 'Project body.' });
    expect(detail.functions).toBeUndefined();
    expect(teaching).toMatchObject({ found: true, scope: 'project' });
    expect(loaded.ok).toBe(true);
    for (const content of [teaching!.content, loaded.text]) {
      expect(content).toContain('Project body.');
      expect(content).toContain(path.join(installed.path, 'references', 'sample.md'));
      expect(content).not.toContain('Global body.');
      expect(content).not.toContain('globalOnly');
    }
  });

  it('loads assigned project teaching and records its actual scope for both Worker consumers', async () => {
    const { name, catalog } = await sources();
    let docs = '';
    const host = {
      id: 'sample-worker', mainAgentId: 'sample-main', spec: { name: 'local-worker' },
      getSkillCatalog: () => catalog, getModule: () => undefined,
      getSkillDocs: () => docs, setSkillDocs: (content: string) => { docs = content; },
    } as unknown as AgentHost;
    const options = {
      isResume: true, mainAgentId: 'sample-main', workspace,
      runConfig: { name: 'Sample', description: '', promptTemplate: '', workspace },
      subagentConfig: { skills: [name], subject: 'Sample', prompt: 'Sample', taskIds: [], type: 'local-worker' },
    } as RuntimeOptions;
    const role = new WorkerRole();
    await role.onStart(host, options);
    expect(docs).toContain('Project body.');
    const builder = new ToolContextBuilder();
    const inventory = vi.spyOn(builder, 'setSkillInventory');
    role.enrichToolContext(builder, host, options);
    expect(inventory).toHaveBeenLastCalledWith(expect.objectContaining({
      entries: { [name]: { tier: 'full', scope: 'project' } },
    }));

    docs = '';
    const browser = new BrowserModule();
    browser.init(host, { workspace, skills: [name] });
    await (browser as unknown as { loadSkillDocs(catalog: SkillCatalogPort): Promise<void> }).loadSkillDocs(catalog);
    expect(docs).toContain('Browser core guide.');
    expect(docs).toContain('Project body.');
    expect(docs).not.toContain('Global body.');
    browser.contributeTools(builder);
    expect(inventory).toHaveBeenLastCalledWith(expect.objectContaining({
      entries: { [name]: { tier: 'full', scope: 'project' } },
    }));
  });

  it('uses the same default-workspace exclusion in enumeration and loading', async () => {
    const { name, catalog } = await sources();
    vi.spyOn(pathsService, 'getDefaultWorkspaceDir').mockReturnValue(workspace);
    const inventory = await buildSkillInventory(catalog, { workspace, defaultWorkspaceDir: workspace });
    const search = await createSkillSearchSource(catalog).listSearchableSkills(workspace);
    const loaded = await new LoadSkillTool(catalog).execute({ skill: name }, {
      agentSpec: 'director', runConfig: { workspace },
    } as ToolContext);
    expect(inventory.snapshot.entries[name].scope).toBe('user');
    expect(search[0]).toMatchObject({ scope: 'user', body: 'Global body.' });
    expect(loaded.ok).toBe(true);
    expect(loaded.text).toContain('Global body.');
    expect(loaded.text).not.toContain('Project body.');
  });

  it('discovers hand-written .agents Skills and existing plugin members', async () => {
    const standalone = path.join(workspace, '.agents', 'skills', 'manual-guide');
    const member = path.join(workspace, '.piskie', 'plugins', 'sample-kit', 'skills', 'member-guide');
    await writeGuide(standalone, 'manual-guide', 'Manual guide.');
    await writeGuide(member, 'member-guide', 'Plugin member guide.');
    await writeGuide(path.join(workspace, '.piskie', 'skills', 'old-guide'), 'old-guide', 'Legacy guide.');
    const items = await createSkillsPort().list({ scope: 'project', workspaces: [workspace] });
    expect(items).toEqual([
      expect.objectContaining({ name: 'manual-guide', path: standalone }),
      expect.objectContaining({ name: 'member-guide', path: member, plugin: 'sample-kit' }),
    ]);
  });
});
