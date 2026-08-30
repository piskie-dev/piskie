import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { browserSkillCandidateOverlay, type BrowserSkillCandidate } from '../../browser-skill/candidate-overlay.js';
import {
  attachSkillProvenance,
  defineSkill,
} from '../../piskiepilot/core/skill/define.js';
import { browserSkillDirectorSpec } from '../specs/builtin/browser-skill-director.js';
import { browserSkillBuilderSpec } from '../specs/builtin/browser-skill-builder.js';
import { browserSkillVerifierSpec } from '../specs/builtin/browser-skill-verifier.js';
import { localWorkerSpec } from '../specs/builtin/local-worker.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { ToolCatalog, type CatalogSnapshot, type FinalToolFace } from '../../tools/catalog.js';
import { buildLoadedSkillEntries } from '../../tools/skill/domain-descriptors.js';
import { z } from '../../tools/params.js';

const MAIN_AGENT_ID = 'browser-skill-lifecycle';

function runtime(spec = browserSkillDirectorSpec): AgentRuntime {
  const id = spec.role === 'director' ? MAIN_AGENT_ID : `${spec.name}-1`;
  return new AgentRuntime({
    id,
    spec: { ...spec, modules: [] },
    inference: fakeAgentInference(),
    conversationStore: { append: vi.fn(), count: vi.fn(() => 0) } as never,
    options: {
      mainAgentId: MAIN_AGENT_ID,
      initialModel: 'provider::model',
      runConfig: { name: 'lifecycle', description: '', promptTemplate: '' },
      ...(spec.role === 'worker'
        ? {
            mainAgentId: MAIN_AGENT_ID,
            subagentConfig: {
              mode: 'local',
              subject: 'worker',
              taskIds: ['task-1'],
              prompt: 'test',
              skills: [],
            },
          }
        : {}),
    } as never,
  });
}

function candidate(): BrowserSkillCandidate {
  const inspect = {
    description: 'Inspect the current page',
    params: {} as never,
    run: vi.fn(),
  };
  return {
    id: 'demo:' + 'a'.repeat(64),
    sourceDir: '/tmp/demo',
    resourceRoot: '/tmp/demo-build',
    skillName: 'demo',
    loaded: { name: 'demo', domain: 'browser', functions: { inspect }, provenance: {
      root: '/tmp/demo', trust: 'custom', entryPoint: 'skill_call',
    } },
    entries: [],
    builtAt: '2026-08-13T00:00:00.000Z',
  } as BrowserSkillCandidate;
}

function versionedSkill(version: string) {
  return attachSkillProvenance(defineSkill({
    name: 'demo',
    domain: 'browser',
    functions: {
      inspect: {
        description: `inspect-${version}`,
        params: z.object({}),
        async run() {
          return { ok: true as const, text: version };
        },
      },
    },
  }), {
    root: `/tmp/${version}`,
    trust: 'custom',
    entryPoint: 'skill_call',
  });
}

function candidateWithEntries(): BrowserSkillCandidate {
  const loaded = versionedSkill('candidate');
  return {
    ...candidate(),
    loaded,
    entries: buildLoadedSkillEntries(loaded).map((entry) => ({
      modelName: entry.tool.def.name,
      tool: entry.tool,
      trust: 'custom' as const,
      identity: entry.identity,
    })),
  };
}

function catalogSnapshot(
  instance: AgentRuntime,
  catalog: ToolCatalog,
  scope: 'main' | 'subagent',
): CatalogSnapshot {
  const internal = instance as unknown as {
    toolCatalog: ToolCatalog;
    toolFace: FinalToolFace;
    captureCatalogSnapshot(): CatalogSnapshot;
  };
  internal.toolCatalog = catalog;
  internal.toolFace = {
    scope,
    agentType: scope === 'main' ? 'main' : 'worker',
    customTools: [],
    exposedSkillFunctions: [],
    excluded: new Set(),
    domains: new Set(['local', 'browser']),
  };
  return internal.captureCatalogSnapshot();
}

describe('Browser Skill candidate 生命周期', () => {
  afterEach(() => browserSkillCandidateOverlay.clear(MAIN_AGENT_ID));

  it('真实 Runtime Catalog 只向构建角色投影 candidate，普通 Worker 仍解析已安装版本', () => {
    const installed = versionedSkill('installed');
    const catalog = new ToolCatalog();
    const installedEntries = buildLoadedSkillEntries(installed);
    catalog.validateSkillReplacement(installed.name, installed.provenance, installedEntries);
    catalog.replaceSkill(installed.name, installed.provenance, installedEntries);
    browserSkillCandidateOverlay.register(MAIN_AGENT_ID, candidateWithEntries());

    const builder = catalogSnapshot(runtime(browserSkillBuilderSpec), catalog, 'subagent');
    const verifier = runtime(browserSkillVerifierSpec);
    const verifierInternal = verifier as unknown as {
      id: string;
      browserSkillCandidatePin?: ReturnType<typeof browserSkillCandidateOverlay.pin>;
    };
    verifierInternal.browserSkillCandidatePin = browserSkillCandidateOverlay.pin(
      MAIN_AGENT_ID,
      verifier.id,
    );
    const verifierSnapshot = catalogSnapshot(verifier, catalog, 'subagent');
    const ordinary = catalogSnapshot(runtime(localWorkerSpec), catalog, 'subagent');

    expect(builder.resolveSkillFunction('demo', 'inspect')).toMatchObject({
      kind: 'resolved',
      entry: { tool: { def: { description: 'inspect-candidate' } } },
    });
    expect(verifierSnapshot.resolveSkillFunction('demo', 'inspect')).toMatchObject({
      kind: 'resolved',
      entry: { tool: { def: { description: 'inspect-candidate' } } },
    });
    expect(ordinary.resolveSkillFunction('demo', 'inspect')).toMatchObject({
      kind: 'resolved',
      entry: { tool: { def: { description: 'inspect-installed' } } },
    });

    browserSkillCandidateOverlay.releasePin(MAIN_AGENT_ID, verifier.id);
  });

  it('Director 销毁阶段立即撤掉 AgentRun candidate，即使后续模块清理失败', () => {
    browserSkillCandidateOverlay.register(MAIN_AGENT_ID, candidate());
    const instance = runtime() as unknown as {
      collectDestroyTasks(): Array<Promise<unknown>>;
    };

    instance.collectDestroyTasks();

    expect(browserSkillCandidateOverlay.snapshot(MAIN_AGENT_ID)).toBeUndefined();
  });

  it('普通 Worker 销毁不清理父 AgentRun candidate', () => {
    browserSkillCandidateOverlay.register(MAIN_AGENT_ID, candidate());
    const instance = runtime(localWorkerSpec) as unknown as {
      collectDestroyTasks(): Array<Promise<unknown>>;
    };

    instance.collectDestroyTasks();

    expect(browserSkillCandidateOverlay.snapshot(MAIN_AGENT_ID)?.candidate?.skillName)
      .toBe('demo');
  });

  it('Verifier prepare 失败时释放已取得的 candidate pin', async () => {
    browserSkillCandidateOverlay.register(MAIN_AGENT_ID, candidate());
    const instance = runtime(browserSkillVerifierSpec);

    await expect(instance.prepare()).rejects.toThrow();

    expect(() => browserSkillCandidateOverlay.assertBuildAllowed(MAIN_AGENT_ID))
      .not.toThrow();
  });

  it('Verifier 销毁阶段释放 candidate pin', () => {
    browserSkillCandidateOverlay.register(MAIN_AGENT_ID, candidate());
    const instance = runtime(browserSkillVerifierSpec) as unknown as {
      id: string;
      browserSkillCandidatePin?: ReturnType<typeof browserSkillCandidateOverlay.pin>;
      collectDestroyTasks(): Array<Promise<unknown>>;
    };
    instance.browserSkillCandidatePin = browserSkillCandidateOverlay.pin(
      MAIN_AGENT_ID,
      instance.id,
    );

    instance.collectDestroyTasks();

    expect(() => browserSkillCandidateOverlay.assertBuildAllowed(MAIN_AGENT_ID))
      .not.toThrow();
  });
});
