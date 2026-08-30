import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test', getAppPath: () => '/tmp/piskie-test', on: () => undefined },
}));

vi.mock('../../services/paths.service.js', () => ({
  pathsService: {
    getDefaultWorkspaceDir: () => '/tmp/piskie-test/workspace',
    getTempDir: () => '/tmp/piskie-test/tmp',
  },
}));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: { raise: vi.fn(), recover: vi.fn() },
}));
vi.mock('../../agent-runs/compaction-archive.js', () => ({
  compactionArchive: { saveCompaction: vi.fn(), loadCompactions: vi.fn(() => []) },
}));

import { AgentRuntime } from '../agent-runtime.js';
import { browserSkillBuilderSpec } from '../specs/builtin/browser-skill-builder.js';
import { browserSkillDirectorSpec } from '../specs/builtin/browser-skill-director.js';
import { browserSkillVerifierSpec } from '../specs/builtin/browser-skill-verifier.js';
import { directorSpec } from '../specs/builtin/director.js';
import { localWorkerSpec } from '../specs/builtin/local-worker.js';
import { siteScoutSpec } from '../specs/builtin/site-scout.js';
import type { AgentSpec } from '../specs/spec.js';
import {
  BROWSER_BUILDER_EXCLUDES,
  BROWSER_SCOUT_EXCLUDES,
} from '../specs/native-tool-sets.js';
import browserCore from '../../piskiepilot/browser/skills/browser/skill.js';
import {
  attachSkillProvenance,
  skillToolName,
} from '../../piskiepilot/core/skill/define.js';
import { createProcessToolCatalog } from '../../tools/index.js';
import type { FinalToolFace } from '../../tools/catalog.js';
import type { ToolActivationContext } from '../tool-call/context-builder.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';

const loadedBrowserCore = attachSkillProvenance(browserCore, {
  root: '/builtin/browser',
  trust: 'builtin',
  entryPoint: 'direct',
});
const browserCoreNames = Object.keys(browserCore.functions)
  .map((name) => skillToolName(browserCore.name, name));
const catalog = createProcessToolCatalog(undefined, {
  getExecutableSkills: () => [loadedBrowserCore],
} as never);

function finalDefinitions(spec: AgentSpec) {
  const browser = spec.tools.sdkGroups.includes('browser');
  const mainAgentId = spec.role === 'worker' ? 'browser-skill-director' : `main-${spec.name}`;
  const agentId = spec.role === 'worker' ? `${spec.name}-worker` : mainAgentId;
  const runConfig = { name: spec.name, description: '', promptTemplate: '' };
  const subagentConfig = spec.role === 'worker'
    ? {
        mode: browser ? 'browser' as const : 'local' as const,
        subject: spec.name,
        taskIds: ['task-1'],
        prompt: 'test assignment',
        skills: browser ? ['browser'] : [],
      }
    : undefined;
  const skills = {
    getToolCatalog: () => catalog,
    getDirectSkillToolNames: (groups: readonly string[]) => (
      groups.includes('browser') ? browserCoreNames : []
    ),
  };
  const runtime = new AgentRuntime({
    id: agentId,
    spec: { ...spec, modules: [] },
    inference: fakeAgentInference(),
    pilotPorts: { skills, browser: {} } as never,
    conversationStore: { append: vi.fn(), count: vi.fn(() => 0) } as never,
    options: {
      mainAgentId,
      initialModel: 'provider::model',
      runConfig,
      ...(spec.role === 'worker'
        ? {
            mainAgentId,
            subagentConfig,
          }
        : {}),
    } as never,
  });
  const activation = {
    agentType: spec.role === 'worker' ? 'worker' : 'main',
    agentSpec: spec.name,
    agentId,
    mainAgentId,
    runConfig,
    ...(spec.role === 'worker' ? { subagentConfig } : {}),
    resourceIds: browser ? { browserId: 'browser-1' } : {},
    currentModel: () => 'provider::model',
    workspace: { dir: '/tmp/piskie-test/workspace', tempDir: '/tmp/piskie-test/tmp' },
    modes: { modeId: () => 'normal' as const, approvalMode: () => 'auto' as const },
    post: () => true,
    ...(browser ? { browser: {} } : {}),
  } as ToolActivationContext;
  const face = (runtime as unknown as {
    createToolFace(value: ToolActivationContext): FinalToolFace;
  }).createToolFace(activation);
  return catalog.snapshot(face).definitions();
}

function names(spec: AgentSpec): string[] {
  return finalDefinitions(spec).map((definition) => definition.name).sort();
}

function added(base: readonly string[], extended: readonly string[]): string[] {
  const baseline = new Set(base);
  return extended.filter((name) => !baseline.has(name));
}

function definition(spec: AgentSpec, name: string) {
  const found = finalDefinitions(spec).find((candidate) => candidate.name === name);
  expect(found, `${spec.name} should expose ${name}`).toBeDefined();
  return found!;
}

describe('Browser Skill 最终模型工具面', () => {
  it('Director 只在完整通用 Director 工具面上增加 status/publish', () => {
    const normal = names(directorSpec);
    const browserSkill = names(browserSkillDirectorSpec);

    expect(added(normal, browserSkill)).toEqual([
      'browser_skill_publish',
      'browser_skill_status',
    ]);
    expect(added(browserSkill, normal)).toEqual([]);
  });

  it('普通 Director 不看到 Browser Skill 专属 Worker type', () => {
    const subagent = definition(directorSpec, 'subagent').input_schema;
    expect((subagent.properties?.type as { enum?: string[] }).enum).toEqual([
      'browser',
      'local',
    ]);
    expect(JSON.stringify(subagent.properties?.type)).not.toMatch(
      /site-scout|browser-skill-builder|browser-skill-verifier/,
    );
  });

  it('Builder 独占 build；Scout/Verifier 只获得各自需要的浏览器投影', () => {
    const scout = names(siteScoutSpec);
    const builder = names(browserSkillBuilderSpec);
    const verifier = names(browserSkillVerifierSpec);
    const readNavigation = [
      'browser_goBack',
      'browser_listPages',
      'browser_navigateTo',
      'browser_refresh',
      'browser_selectPage',
      'browser_takeScreenshot',
      'browser_takeSnapshot',
    ].sort();
    const scoutExploration = [
      ...readNavigation,
      'browser_clickByUid',
      'browser_hoverByUid',
    ].sort();

    expect(builder).toContain('browser_skill_build');
    expect(builder).not.toContain('plan');
    expect(verifier).not.toContain('plan');
    expect(scout).not.toContain('browser_skill_build');
    expect(verifier).not.toContain('browser_skill_build');
    expect(scout).not.toContain('browser_skill_publish');
    expect(verifier).not.toContain('browser_skill_publish');
    expect(scout).not.toContain('load_skill');
    expect(scout).not.toContain('skill_call');
    expect(scout).toContain('send_event');
    expect(verifier).toContain('load_skill');
    expect(verifier).toContain('skill_call');
    expect(scout.filter((name) => browserCoreNames.includes(name)).sort()).toEqual(scoutExploration);
    expect(verifier.filter((name) => browserCoreNames.includes(name)).sort()).toEqual(readNavigation);
    expect(scout).not.toContain('browser_fillByUid');
    expect(scout).not.toContain('browser_fillFormByUids');
    expect(scout).not.toContain('browser_evaluateScript');
    expect(BROWSER_SCOUT_EXCLUDES).toEqual(expect.arrayContaining([
      'browser_fillByUid',
      'browser_fillFormByUids',
      'browser_evaluateScript',
    ]));
    expect(builder.filter((name) => browserCoreNames.includes(name)).sort())
      .toEqual(browserCoreNames.filter((name) => !BROWSER_BUILDER_EXCLUDES.includes(name)).sort());
    expect(BROWSER_BUILDER_EXCLUDES.slice().sort()).toEqual([
      'browser_clearCookies',
      'browser_closeBrowser',
      'browser_deleteCookies',
      'browser_getAllCookies',
      'browser_getWindowBounds',
      'browser_setCookies',
      'browser_setWindowBounds',
    ]);
    expect(builder).toEqual(expect.arrayContaining([
      'browser_clickByUid',
      'browser_evaluateScript',
      'browser_fillByUid',
      'browser_hoverByUid',
      'browser_listPages',
      'browser_selectPage',
      'browser_takeScreenshot',
      'browser_takeSnapshot',
    ]));
  });

  it('三个专用工具 Schema 保持紧凑，subagent 和业务调用都不暴露宿主 ID', () => {
    const buildTool = definition(browserSkillBuilderSpec, 'browser_skill_build');
    const build = buildTool.input_schema;
    const status = definition(browserSkillDirectorSpec, 'browser_skill_status').input_schema;
    const publish = definition(browserSkillDirectorSpec, 'browser_skill_publish').input_schema;
    const subagent = definition(browserSkillDirectorSpec, 'subagent').input_schema;
    const skillCall = definition(localWorkerSpec, 'skill_call').input_schema;

    expect(Object.keys(build.properties ?? {}).sort()).toEqual(['skillName', 'sourceDir']);
    expect(Object.keys(status.properties ?? {})).toEqual([]);
    expect(Object.keys(publish.properties ?? {}).sort()).toEqual(['force']);
    expect(subagent.properties).not.toHaveProperty('browserSkillAssignment');
    expect((subagent.properties?.type as { enum?: string[] }).enum).toEqual([
      'browser',
      'local',
      'browser-skill-builder',
      'browser-skill-verifier',
      'site-scout',
    ]);
    const subagentTypeDescription = (subagent.properties?.type as { description?: string }).description;
    expect(subagentTypeDescription).toContain('site-scout：有界侦察网站能力');
    expect(subagentTypeDescription).toContain('browser-skill-builder：深入探索目标流程，设计并编写完整业务工具');
    expect(subagentTypeDescription).toContain('browser-skill-verifier：在独立上下文验证');
    expect(buildTool.description).toContain('具有完整业务意义的公开函数');
    expect(buildTool.description).toContain('只供唯一下一步使用的中间函数');
    expect(buildTool.description).not.toContain('每新增或修改一个业务函数后');
    expect(Object.keys(skillCall.properties ?? {}).sort()).toEqual(['args', 'function', 'skill']);
    expect(definition(localWorkerSpec, 'skill_call').description)
      .toContain('Skill 使用说明中指定通过本工具执行的公开函数');
    expect(definition(localWorkerSpec, 'skill_call').description).not.toMatch(
      /xhs-publisher|detectState/,
    );
    expect(JSON.stringify({ build, status, publish, skillCall })).not.toMatch(
      /browserId|taskId|agentId|callId|candidateId|hash|revision|pin/,
    );
  });
});
