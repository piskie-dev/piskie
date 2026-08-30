import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/piskie-browser-skill-consumption',
    getAppPath: () => '/tmp/piskie-browser-skill-consumption',
    on: () => undefined,
  },
}));

vi.mock('../../services/paths.service.js', () => ({
  pathsService: {
    getDefaultWorkspaceDir: () => '/tmp/piskie-browser-skill-consumption/workspace',
    getTempDir: (agentId: string) => `/tmp/piskie-browser-skill-consumption/${agentId}`,
  },
}));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: { raise: vi.fn(), recover: vi.fn() },
}));
vi.mock('../../agent-runs/compaction-archive.js', () => ({
  compactionArchive: { saveCompaction: vi.fn(), loadCompactions: vi.fn(() => []) },
}));

import { AgentRuntime } from '../agent-runtime.js';
import { BrowserModule } from '../modules/browser.module.js';
import { browserWorkerSpec } from '../specs/builtin/browser-worker.js';
import { attachSkillProvenance, defineSkill } from '../../piskiepilot/core/skill/define.js';
import type { SkillCatalogPort } from '../../core/pilot/pilot-manager.js';
import type { AgentHost } from '../agent-host.js';
import type { ToolActivationContext } from '../tool-call/context-builder.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { ToolCatalog } from '../../tools/catalog.js';
import { LoadSkillTool } from '../../tools/skill/load-skill.tool.js';
import { SkillCallTool } from '../../tools/skill/skill-call.tool.js';
import { buildLoadedSkillEntries } from '../../tools/skill/domain-descriptors.js';
import { ToolCoordinator } from '../../tools/coordinator.js';
import { ToolCallContextFactory } from '../tool-call/context-builder.js';
import { z } from '../../tools/params.js';

const SKILL = 'example-site';

function installedSkill() {
  return attachSkillProvenance(defineSkill({
    name: SKILL,
    domain: 'browser',
    functions: {
      searchOptions: {
        description: 'Search the installed website and return reusable option IDs.',
        params: z.object({ query: z.string().describe('User search terms') }),
        async run({ query }, ctx) {
          const page = await ctx.browser.page.currentPage();
          return {
            ok: true as const,
            text: JSON.stringify({ query, url: page.url, optionIds: ['option-1'] }),
          };
        },
      },
    },
  }), {
    root: '/tmp/piskie-browser-skill-consumption/installed',
    trust: 'custom',
    entryPoint: 'skill_call',
  });
}

function skillPort(catalog: ToolCatalog): SkillCatalogPort {
  const loaded = installedSkill();
  return {
    getToolCatalog: () => catalog,
    getDirectSkillToolNames: () => [],
    classifySkill: vi.fn(async () => 'unknown' as const),
    loadSkillDocs: vi.fn(async () => '# Browser'),
    getSkillDocs: vi.fn(async (name: string) => (
      name === SKILL
        ? [
            '---',
            `name: ${SKILL}`,
            'type: browser',
            'description: Use this Skill first for Example Site searches.',
            '---',
            '',
            '# Example Site',
            '',
            'Use `searchOptions` for covered searches before falling back to browser.',
          ].join('\n')
        : ''
    )),
    getSkillResourceRoot: () => '/tmp/piskie-browser-skill-consumption/installed',
    getLoadedSkillModule: (name: string) => name === SKILL ? loaded : undefined,
    listManagedSkills: vi.fn(async () => []),
  } as SkillCatalogPort;
}

function browserRuntime() {
  return {
    page: {
      currentPage: vi.fn(async () => ({ url: 'https://example.test/results', title: 'Results' })),
      navigate: vi.fn(),
      click: vi.fn(),
      fill: vi.fn(),
      select: vi.fn(),
      press: vi.fn(),
      waitFor: vi.fn(),
      extractText: vi.fn(),
      extractList: vi.fn(),
    },
  };
}

describe('已安装 Browser Skill 的 normal/plan 通用消费链', () => {
  it.each(['normal', 'plan'] as const)(
    '%s Director 的标准 skills Assignment 进入普通 browser-worker，并能执行 skill_call',
    async (mode) => {
      const catalog = new ToolCatalog();
      const skills = skillPort(catalog);
      const loaded = skills.getLoadedSkillModule(SKILL)!;
      catalog.register(new LoadSkillTool(skills), 'builtin');
      catalog.register(new SkillCallTool(), 'builtin');
      const entries = buildLoadedSkillEntries(loaded);
      catalog.validateSkillReplacement(SKILL, loaded.provenance, entries);
      catalog.replaceSkill(SKILL, loaded.provenance, entries);

      const assignment = {
        mode: 'browser' as const,
        subject: '在 Example Site 搜索',
        taskIds: ['task-1'],
        prompt: '使用已安装网站 Skill 搜索 red shoes，并返回 optionIds。',
        skills: [SKILL],
      };
      const setSkillDocs = vi.fn();
      let docs = '';
      const host = {
        id: `${mode}-browser-worker`,
        mainAgentId: `${mode}-director`,
        getSkillCatalog: () => skills,
        getBrowserControl: () => null,
        getSkillDocs: () => docs,
        setSkillDocs: (value: string) => {
          docs = value;
          setSkillDocs(value);
        },
        emitStateChange: vi.fn(),
      } as unknown as AgentHost;
      const browserModule = new BrowserModule();
      browserModule.init(host, {
        mode: 'local',
        skills: assignment.skills,
      });

      await browserModule.onStart();

      expect(setSkillDocs).toHaveBeenCalledOnce();
      expect(docs).toContain('# Example Site');
      expect(docs).toContain('searchOptions(query*)');
      expect(docs).toContain(`skill_call({ skill: "${SKILL}"`);

      const runtime = new AgentRuntime({
        id: `${mode}-browser-worker`,
        spec: { ...browserWorkerSpec, modules: [] },
        inference: fakeAgentInference(),
        pilotPorts: { skills } as never,
        conversationStore: { append: vi.fn(), count: vi.fn(() => 0) } as never,
        options: {
          mainAgentId: `${mode}-director`,
          initialModel: 'provider::model',
          runConfig: {
            name: `${mode} flow`,
            description: '',
            promptTemplate: '',
          },
          subagentConfig: assignment,
        } as never,
      });
      const createToolFace = runtime as unknown as {
        createToolFace(input: ToolActivationContext): Parameters<ToolCatalog['snapshot']>[0];
      };
      const generated = browserRuntime();
      const activation: ToolActivationContext = {
        agentType: 'worker',
        agentSpec: 'browser-worker',
        agentId: runtime.id,
        mainAgentId: `${mode}-director`,
        runConfig: {
          name: `${mode} flow`,
          description: '',
          promptTemplate: '',
        },
        subagentConfig: assignment,
        resourceIds: { browserId: `${mode}-browser` },
        currentModel: () => 'provider::model',
        workspace: { dir: '/tmp/workspace', tempDir: '/tmp/worker' },
        modes: { modeId: () => mode, approvalMode: () => 'auto' },
        browser: {
          createGeneratedRuntime: vi.fn(() => generated),
        } as never,
        post: () => true,
      };
      const face = createToolFace.createToolFace(activation);
      const snapshot = catalog.snapshot(face);

      expect(snapshot.definitions().map(({ name }) => name)).toContain('load_skill');
      expect(snapshot.definitions().map(({ name }) => name)).toContain('skill_call');
      expect(snapshot.definitions().map(({ name }) => name)).not.toContain(
        `${SKILL}_searchOptions`,
      );

      const coordinator = new ToolCoordinator({
        contexts: new ToolCallContextFactory({
          activation,
          signal: () => new AbortController().signal,
        }),
      });
      const called = await coordinator.run({
        modelName: 'skill_call',
        rawParams: {
          skill: SKILL,
          function: 'searchOptions',
          args: { query: 'red shoes' },
        },
        callId: `${mode}-call`,
      }, snapshot);
      if ('suspended' in called) throw new Error('skill_call unexpectedly suspended');

      expect(called.result).toEqual({
        ok: true,
        text: JSON.stringify({
          query: 'red shoes',
          url: 'https://example.test/results',
          optionIds: ['option-1'],
        }),
      });
      expect(activation.browser?.createGeneratedRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          browserId: `${mode}-browser`,
        }),
      );
    },
  );
});
