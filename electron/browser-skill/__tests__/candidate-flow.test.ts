import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../skills/executable/host-shim.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../skills/executable/host-shim.js')>();
  return {
    ...actual,
    async writeExecutableSkillShim(...args: Parameters<typeof actual.writeExecutableSkillShim>) {
      const result = await actual.writeExecutableSkillShim(...args);
      const { writeFile: writeRuntimeBridge } = await import('node:fs/promises');
      const { pathToFileURL } = await import('node:url');
      const zodUrl = pathToFileURL(path.join(process.cwd(), 'node_modules/zod/index.js')).href;
      const runtimeBridge = [
        `import { z } from ${JSON.stringify(zodUrl)}`,
        'export { z }',
        'export const defineSkill = (definition) => Object.freeze(definition)',
        'export const ok = (text, extra = {}) => ({ ok: true, text, ...extra })',
        'export const fail = (text, data) => ({ ok: false, text, data })',
        '',
      ].join('\n');
      await writeRuntimeBridge(path.join(result.dir, 'core-skill.js'), runtimeBridge, 'utf8');
      return result;
    },
  };
});

import { ToolCallContextFactory, type ToolActivationContext } from '../../agent/tool-call/context-builder.js';
import { setPilotRoot } from '../../piskiepilot/paths.js';
import {
  attachSkillProvenance,
  defineSkill,
  type GeneratedBrowserSkillRuntime,
} from '../../piskiepilot/core/skill/define.js';
import type { BrowserHostRuntime } from '../../piskiepilot/core/skill/host.js';
import { buildBrowserSkillCandidate } from '../application/build-candidate.js';
import { getBrowserSkillBuildStatus } from '../application/get-build-status.js';
import { publishBrowserSkillCandidate } from '../application/publish-skill.js';
import { browserSkillCandidateOverlay } from '../candidate-overlay.js';
import { ToolCatalog, type CatalogSnapshot, type FinalToolFace } from '../../tools/catalog.js';
import { ToolCoordinator } from '../../tools/coordinator.js';
import { z } from '../../tools/params.js';
import { BrowserSkillBuildTool } from '../../tools/browser-skill/build.tool.js';
import { BrowserSkillPublishTool } from '../../tools/browser-skill/publish.tool.js';
import { BrowserSkillStatusTool } from '../../tools/browser-skill/status.tool.js';
import { buildLoadedSkillEntries } from '../../tools/skill/domain-descriptors.js';
import { LoadSkillTool } from '../../tools/skill/load-skill.tool.js';
import { SkillCallTool } from '../../tools/skill/skill-call.tool.js';
import type { ITool, ToolContext, ToolResult } from '../../tools/types.js';

const SKILL = 'candidate-demo';
const MAIN_A = 'browser-skill-run-a';
const MAIN_B = 'browser-skill-run-b';
const COMPILE_TEST_TIMEOUT_MS = 20_000;

function face(scope: 'main' | 'subagent'): FinalToolFace {
  return {
    scope,
    agentType: scope === 'main' ? 'main' : 'worker',
    customTools: ['load_skill', 'skill_call'],
    exposedSkillFunctions: [],
    excluded: new Set(),
    domains: new Set(['local', 'browser']),
  };
}

describe('Browser Skill AgentRun-local candidate', () => {
  let root: string;
  let sourceA: string;
  let sourceB: string;
  let catalog: ToolCatalog;
  let installed: ReturnType<typeof installedSkill>;
  let browser: BrowserHostRuntime;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'browser-skill-candidate-'));
    setPilotRoot(path.join(root, 'pilot'));
    sourceA = path.join(root, 'run-a', SKILL);
    sourceB = path.join(root, 'run-b', SKILL);
    await Promise.all([
      writeBrowserSkill(sourceA, 'flow-a-v1'),
      writeBrowserSkill(sourceB, 'flow-b-v1'),
    ]);

    installed = installedSkill();
    catalog = new ToolCatalog();
    catalog.register(new SkillCallTool(), 'builtin');
    catalog.register(new LoadSkillTool(installedTeachingPort(installed)), 'builtin');
    const installedEntries = buildLoadedSkillEntries(installed);
    catalog.validateSkillReplacement(SKILL, installed.provenance, installedEntries);
    catalog.replaceSkill(SKILL, installed.provenance, installedEntries);
    browser = browserRuntime();
  }, COMPILE_TEST_TIMEOUT_MS);

  afterEach(async () => {
    browserSkillCandidateOverlay.clear(MAIN_A);
    browserSkillCandidateOverlay.clear(MAIN_B);
    setPilotRoot(path.join(process.cwd(), '.piskiepilot'));
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }, COMPILE_TEST_TIMEOUT_MS);

  it('build 后同 AgentRun 立即 load/call，不同 AgentRun 隔离且不进入基础 Catalog', async () => {
    const candidateA = await buildBrowserSkillCandidate({ mainAgentId: MAIN_A, sourceDir: sourceA });
    const candidateB = await buildBrowserSkillCandidate({ mainAgentId: MAIN_B, sourceDir: sourceB });

    expect(candidateA.id).not.toBe(candidateB.id);
    expect(browserSkillCandidateOverlay.candidate(MAIN_A)?.id).toBe(candidateA.id);
    expect(browserSkillCandidateOverlay.candidate(MAIN_B)?.id).toBe(candidateB.id);

    const builderTeaching = await new LoadSkillTool(installedTeachingPort(installed)).execute(
      { skill: SKILL },
      toolContext(MAIN_A, 'browser-skill-builder', browser),
    );
    const verifierTeaching = await new LoadSkillTool(installedTeachingPort(installed)).execute(
      { skill: SKILL },
      toolContext(MAIN_A, 'browser-skill-verifier', browser),
    );
    const otherRunTeaching = await new LoadSkillTool(installedTeachingPort(installed)).execute(
      { skill: SKILL },
      toolContext(MAIN_B, 'browser-skill-builder', browser),
    );
    const ordinaryWorkerTeaching = await new LoadSkillTool(installedTeachingPort(installed)).execute(
      { skill: SKILL },
      toolContext(MAIN_A, 'browser-worker', browser),
    );

    expect(builderTeaching.ok).toBe(true);
    expect(builderTeaching.text).toContain('flow-a-v1');
    expect(builderTeaching.text).toContain('inspect(suffix*)');
    expect(builderTeaching.text).not.toContain(candidateA.resourceRoot);
    expect(builderTeaching.text).not.toContain(path.join(sourceA, 'SKILL.md'));
    expect(verifierTeaching.text).toBe(builderTeaching.text);
    expect(otherRunTeaching.text).toContain('flow-b-v1');
    expect(otherRunTeaching.text).not.toContain('flow-a-v1');
    expect(ordinaryWorkerTeaching.text).toContain('Installed teaching');
    expect(ordinaryWorkerTeaching.text).not.toContain('flow-a-v1');

    await expect(callCandidate(MAIN_A, 'builder', snapshotFor(MAIN_A, catalog), browser, 'A'))
      .resolves.toMatchObject({ version: 'flow-a-v1', suffix: 'A', url: 'https://example.test/current' });
    await expect(callCandidate(MAIN_A, 'verifier', snapshotFor(MAIN_A, catalog), browser, 'V'))
      .resolves.toMatchObject({ version: 'flow-a-v1', suffix: 'V' });
    await expect(callCandidate(MAIN_B, 'builder', snapshotFor(MAIN_B, catalog), browser, 'B'))
      .resolves.toMatchObject({ version: 'flow-b-v1', suffix: 'B' });

    const base = catalog.snapshot(face('subagent'));
    expect(base.resolveSkillFunction(SKILL, 'candidateOnly')).toEqual({
      kind: 'unknownFunction',
      available: ['inspect'],
    });
    expect(await callCandidate(MAIN_A, 'base', base, browser, 'installed'))
      .toEqual({ version: 'installed', suffix: 'installed' });
  }, COMPILE_TEST_TIMEOUT_MS);

  it('load_skill 读取固定 build 内容，但不向模型暴露 hash 目录', async () => {
    const referencesDir = path.join(sourceA, 'references');
    const referencePath = path.join(referencesDir, 'usage.md');
    await mkdir(referencesDir, { recursive: true });
    await writeFile(referencePath, 'candidate-reference-v1\n', 'utf8');
    const candidate = await buildBrowserSkillCandidate({ mainAgentId: MAIN_A, sourceDir: sourceA });

    await writeFile(referencePath, 'unbuilt-reference-v2\n', 'utf8');
    await writeFile(path.join(referencesDir, 'unbuilt-only.md'), 'not in candidate\n', 'utf8');
    await writeBrowserSkill(sourceA, 'unbuilt-doc-v2');
    const teaching = await new LoadSkillTool(installedTeachingPort(installed)).execute(
      { skill: SKILL },
      toolContext(MAIN_A, 'browser-skill-verifier', browser),
    );
    const frozenReference = path.join(candidate.resourceRoot, 'references', 'usage.md');

    expect(teaching.ok).toBe(true);
    expect(teaching.text).toContain('# Candidate flow-a-v1');
    expect(teaching.text).not.toContain('unbuilt-doc-v2');
    expect(teaching.text).not.toContain(candidate.resourceRoot);
    expect(teaching.text).not.toContain(frozenReference);
    expect(teaching.text).not.toContain(referencePath);
    expect(teaching.text).not.toContain('unbuilt-only.md');
    await expect(readFile(frozenReference, 'utf8')).resolves.toBe('candidate-reference-v1\n');
    await expect(readFile(referencePath, 'utf8')).resolves.toBe('unbuilt-reference-v2\n');
  }, COMPILE_TEST_TIMEOUT_MS);

  it('新 build 只产生新版本目录，失败保留上一 candidate，AgentRun 清理恢复已安装版本', async () => {
    const first = await buildBrowserSkillCandidate({ mainAgentId: MAIN_A, sourceDir: sourceA });
    const frozenV1 = snapshotFor(MAIN_A, catalog);

    await writeBrowserSkill(sourceA, 'flow-a-v2');
    const second = await buildBrowserSkillCandidate({ mainAgentId: MAIN_A, sourceDir: sourceA });
    const frozenV2 = snapshotFor(MAIN_A, catalog);

    expect(second.id).not.toBe(first.id);
    await expect(callCandidate(MAIN_A, 'old-snapshot', frozenV1, browser, 'old'))
      .resolves.toMatchObject({ version: 'flow-a-v1' });
    await expect(callCandidate(MAIN_A, 'new-snapshot', frozenV2, browser, 'new'))
      .resolves.toMatchObject({ version: 'flow-a-v2' });

    await writeBrowserSkill(sourceA, 'broken', { invalidSdkCall: true });
    const failed = await new BrowserSkillBuildTool(catalog).execute(
      { sourceDir: sourceA, skillName: SKILL },
      toolContext(MAIN_A, 'browser-skill-builder', browser),
    );
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain('TS2339');
    expect(failed.text).toContain(`上一份成功构建仍可用: ${SKILL}`);
    expect(failed.text).not.toContain(second.id);
    expect(getBrowserSkillBuildStatus(MAIN_A)).toMatchObject({
      candidate: { id: second.id },
      lastBuild: { ok: false },
    });
    await expect(callCandidate(MAIN_A, 'retained', snapshotFor(MAIN_A, catalog), browser, 'retained'))
      .resolves.toMatchObject({ version: 'flow-a-v2' });

    browserSkillCandidateOverlay.clear(MAIN_A);
    expect(getBrowserSkillBuildStatus(MAIN_A)).toBeUndefined();
    await expect(callCandidate(MAIN_A, 'installed', snapshotFor(MAIN_A, catalog), browser, 'restored'))
      .resolves.toEqual({ version: 'installed', suffix: 'restored' });

    const teaching = await new LoadSkillTool(installedTeachingPort(installed)).execute(
      { skill: SKILL },
      toolContext(MAIN_A, 'director', browser),
    );
    expect(teaching.text).toContain('Installed teaching');
    expect(teaching.text).not.toContain('flow-a-v2');
  }, COMPILE_TEST_TIMEOUT_MS);

  it('Verifier pin 冻结同一 candidate，验证期间禁止 build，释放后可继续修复', async () => {
    const first = await buildBrowserSkillCandidate({ mainAgentId: MAIN_A, sourceDir: sourceA });
    const pin = browserSkillCandidateOverlay.pin(MAIN_A, 'verifier-1');

    expect(pin.candidate.id).toBe(first.id);
    expect(browserSkillCandidateOverlay.candidate(MAIN_A, SKILL, 'verifier-1')?.id).toBe(first.id);

    await writeBrowserSkill(sourceA, 'flow-a-v2');
    const blocked = await new BrowserSkillBuildTool(catalog).execute(
      { sourceDir: sourceA, skillName: SKILL },
      toolContext(MAIN_A, 'browser-skill-builder', browser),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.text).toContain('cannot be rebuilt while independent validation is running');
    expect(browserSkillCandidateOverlay.candidate(MAIN_A)?.id).toBe(first.id);

    const teaching = await new LoadSkillTool(installedTeachingPort(installed)).execute(
      { skill: SKILL },
      toolContext(MAIN_A, 'browser-skill-verifier', browser, 'verifier-1'),
    );
    expect(teaching.text).toContain('flow-a-v1');
    expect(teaching.text).not.toContain('flow-a-v2');

    browserSkillCandidateOverlay.releasePin(MAIN_A, 'verifier-1');
    const second = await buildBrowserSkillCandidate({ mainAgentId: MAIN_A, sourceDir: sourceA });
    expect(second.id).not.toBe(first.id);
    expect(browserSkillCandidateOverlay.candidate(MAIN_A)?.id).toBe(second.id);
  }, COMPILE_TEST_TIMEOUT_MS);

  it('Catalog 冲突 build 不替换当前 candidate', async () => {
    const first = await buildBrowserSkillCandidate({ mainAgentId: MAIN_A, sourceDir: sourceA });
    catalog.register(nativeTool(`${SKILL}_reserved`), 'builtin');
    await writeBrowserSkill(sourceA, 'conflicting', { reservedFunction: true });

    const result = await new BrowserSkillBuildTool(catalog).execute(
      { sourceDir: sourceA, skillName: SKILL },
      toolContext(MAIN_A, 'browser-skill-builder', browser),
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain(`Catalog modelName conflict: ${SKILL}_reserved`);
    expect(browserSkillCandidateOverlay.candidate(MAIN_A)?.id).toBe(first.id);
  }, COMPILE_TEST_TIMEOUT_MS);

  it('通过 skill_call 组合业务函数，并把上游 text 的稳定业务键直接交给下游', async () => {
    const workflow = workflowBrowserRuntime();
    await writeComposableBrowserSkill(sourceA, 'composition-v1');
    await buildBrowserSkillCandidate({ mainAgentId: MAIN_A, sourceDir: sourceA });
    const snapshot = snapshotFor(MAIN_A, catalog);

    const teaching = await new LoadSkillTool(installedTeachingPort(installed)).execute(
      { skill: SKILL },
      toolContext(MAIN_A, 'browser-skill-builder', workflow.browser),
    );
    expect(teaching.ok).toBe(true);
    expect(teaching.text).toContain('searchOptions(query*)');
    expect(teaching.text).toContain('selectOption(selectionKey*)');
    expect(teaching.text).toContain('options[].selectionKey');
    expect(teaching.data).toEqual({ skill: SKILL });

    const searched = await runSkillCall({
      mainAgentId: MAIN_A,
      agentId: 'builder',
      snapshot,
      browser: workflow.browser,
      functionName: 'searchOptions',
      args: { query: 'Shanghai to Beijing' },
    });
    expect(searched.ok).toBe(true);
    const searchResult = JSON.parse(searched.text) as {
      state: string;
      options: Array<{ selectionKey: string; summary: string }>;
    };
    expect(searchResult).toEqual({
      state: 'results-ready',
      options: [{ selectionKey: 'offer-42', summary: 'Nonstop option' }],
    });
    expect(searched.text.toLowerCase()).not.toContain('uid');

    const selected = await runSkillCall({
      mainAgentId: MAIN_A,
      agentId: 'builder',
      snapshot,
      browser: workflow.browser,
      functionName: 'selectOption',
      args: { selectionKey: searchResult.options[0].selectionKey },
    });
    expect(selected).toMatchObject({ ok: true });
    expect(JSON.parse(selected.text)).toEqual({
      state: 'option-selected',
      selectionKey: 'offer-42',
    });
    expect(workflow.page.fill).toHaveBeenCalledWith(
      { role: 'textbox', name: 'Search' },
      'Shanghai to Beijing',
    );
    expect(workflow.page.extractList).toHaveBeenCalledTimes(1);
    expect(workflow.page.click).toHaveBeenLastCalledWith({
      css: '[data-selection-key="offer-42"]',
    });
  }, COMPILE_TEST_TIMEOUT_MS);

  it('skill_call 业务失败后修改源码、重新 build，并以新教学和新 candidate 调用成功', async () => {
    const workflow = workflowBrowserRuntime();
    await writeComposableBrowserSkill(sourceA, 'broken-v1', { selectionFails: true });
    const broken = await buildBrowserSkillCandidate({ mainAgentId: MAIN_A, sourceDir: sourceA });

    const failed = await runSkillCall({
      mainAgentId: MAIN_A,
      agentId: 'builder',
      snapshot: snapshotFor(MAIN_A, catalog),
      browser: workflow.browser,
      functionName: 'selectOption',
      args: { selectionKey: 'offer-42' },
    });
    expect(failed).toEqual({
      ok: false,
      text: JSON.stringify({
        stage: 'select-option',
        pageState: 'results-ready',
        error: 'selection control changed',
        recovery: 'inspect the current result item and rebuild this function',
      }),
    });

    await writeComposableBrowserSkill(sourceA, 'fixed-v2');
    const fixed = await buildBrowserSkillCandidate({ mainAgentId: MAIN_A, sourceDir: sourceA });
    expect(fixed.id).not.toBe(broken.id);

    const teaching = await new LoadSkillTool(installedTeachingPort(installed)).execute(
      { skill: SKILL },
      toolContext(MAIN_A, 'browser-skill-builder', workflow.browser),
    );
    expect(teaching.text).toContain('fixed-v2');
    expect(teaching.text).not.toContain('broken-v1');
    expect(teaching.data).toEqual({ skill: SKILL });

    const retried = await runSkillCall({
      mainAgentId: MAIN_A,
      agentId: 'builder',
      snapshot: snapshotFor(MAIN_A, catalog),
      browser: workflow.browser,
      functionName: 'selectOption',
      args: { selectionKey: 'offer-42' },
    });
    expect(retried.ok).toBe(true);
    expect(JSON.parse(retried.text)).toEqual({
      state: 'option-selected',
      selectionKey: 'offer-42',
    });
    expect(getBrowserSkillBuildStatus(MAIN_A)).toMatchObject({
      candidate: { id: fixed.id },
      lastBuild: { ok: true, candidateId: fixed.id },
    });
  }, COMPILE_TEST_TIMEOUT_MS);

  it('拒绝把宿主运行时标识暴露成 candidate 业务参数', async () => {
    await writeBrowserSkill(sourceA, 'host-parameter', { hostParameter: true });

    await expect(buildBrowserSkillCandidate({ mainAgentId: MAIN_A, sourceDir: sourceA }))
      .rejects.toThrow(/cannot expose host runtime parameters: browserId/);
    expect(browserSkillCandidateOverlay.candidate(MAIN_A)).toBeUndefined();
  }, COMPILE_TEST_TIMEOUT_MS);

  it('status 不暴露内部版本；publish 校验源码后只调用统一 SkillsPort.install', async () => {
    const empty = await new BrowserSkillStatusTool().execute(
      {},
      toolContext(MAIN_A, 'director', browser),
    );
    expect(empty).toMatchObject({ ok: true, data: { state: 'empty' } });

    const unavailableInstall = vi.fn();
    await expect(publishBrowserSkillCandidate({
      mainAgentId: MAIN_A,
    }, { install: unavailableInstall })).rejects.toThrow('No successful Browser Skill build');
    expect(unavailableInstall).not.toHaveBeenCalled();

    const candidate = await buildBrowserSkillCandidate({ mainAgentId: MAIN_A, sourceDir: sourceA });
    const build = await new BrowserSkillBuildTool(catalog).execute(
      { sourceDir: sourceA, skillName: SKILL },
      toolContext(MAIN_A, 'browser-skill-builder', browser),
    );
    expect(build.ok).toBe(true);
    expect(build.text).toContain(`skill: ${SKILL}`);
    expect(build.text).not.toContain(candidate.id);
    expect(build.data).toEqual({
      skill: SKILL,
      sourceDir: sourceA,
      functions: ['inspect', 'candidateOnly'],
    });
    const status = await new BrowserSkillStatusTool().execute(
      {},
      toolContext(MAIN_A, 'director', browser),
    );
    expect(status.ok).toBe(true);
    expect(status.text).not.toContain(candidate.id);
    expect(status.text).toContain('inspect');
    expect(status.text).not.toContain('verified');
    expect(status.data).not.toHaveProperty('revision');
    expect(status.data).not.toHaveProperty('candidate');
    expect(status.data).not.toHaveProperty('lastBuild.candidateId');
    expect(status.data).not.toHaveProperty('lastBuild.at');
    expect(status.data).not.toHaveProperty('currentBuild.id');
    expect(status.data).not.toHaveProperty('currentBuild.builtAt');

    const install = vi.fn(async () => ({
      name: SKILL,
      path: '/installed/candidate-demo',
      scope: 'user' as const,
      executionType: 'executable' as const,
      type: 'browser' as const,
      warnings: [],
    }));
    const published = await new BrowserSkillPublishTool({ install }).execute({
      force: true,
    }, toolContext(MAIN_A, 'director', browser));
    expect(published.ok).toBe(true);
    expect(published.text).toContain('统一安装链发布');
    expect(install).toHaveBeenCalledWith({
      source: sourceA,
      scope: 'user',
      force: true,
      allowExecutable: true,
    });

    await writeBrowserSkill(sourceA, 'source-changed');
    const staleInstall = vi.fn();
    const stale = await new BrowserSkillPublishTool({ install: staleInstall }).execute({
      force: false,
    }, toolContext(MAIN_A, 'director', browser));
    expect(stale.ok).toBe(false);
    expect(stale.text).toContain('Source changed after the current build');
    expect(stale.text).not.toContain(candidate.id);
    expect(staleInstall).not.toHaveBeenCalled();
  }, COMPILE_TEST_TIMEOUT_MS);
});

function snapshotFor(mainAgentId: string, catalog: ToolCatalog): CatalogSnapshot {
  const candidate = browserSkillCandidateOverlay.candidate(mainAgentId);
  return catalog.snapshot(face('subagent'), {
    entries: candidate?.entries,
    replaceSkills: candidate ? [candidate.skillName] : undefined,
  });
}

async function callCandidate(
  mainAgentId: string,
  agentId: string,
  snapshot: CatalogSnapshot,
  browser: BrowserHostRuntime,
  suffix: string,
): Promise<Record<string, string>> {
  const coordinator = new ToolCoordinator({
    contexts: new ToolCallContextFactory({
      activation: activation(mainAgentId, agentId, browser),
      signal: () => new AbortController().signal,
    }),
  });
  const pending = await coordinator.run({
    modelName: 'skill_call',
    rawParams: { skill: SKILL, function: 'inspect', args: { suffix } },
    callId: `${agentId}-${suffix}`,
  }, snapshot);
  if ('suspended' in pending) throw new Error('Candidate call unexpectedly suspended');
  expect(pending.result.ok).toBe(true);
  return JSON.parse(pending.result.text) as Record<string, string>;
}

async function runSkillCall(input: {
  mainAgentId: string;
  agentId: string;
  snapshot: CatalogSnapshot;
  browser: BrowserHostRuntime;
  functionName: string;
  args: Record<string, unknown>;
}): Promise<ToolResult> {
  const coordinator = new ToolCoordinator({
    contexts: new ToolCallContextFactory({
      activation: activation(input.mainAgentId, input.agentId, input.browser),
      signal: () => new AbortController().signal,
    }),
  });
  const pending = await coordinator.run({
    modelName: 'skill_call',
    rawParams: {
      skill: SKILL,
      function: input.functionName,
      args: input.args,
    },
    callId: `${input.agentId}-${input.functionName}`,
  }, input.snapshot);
  if ('suspended' in pending) throw new Error('Candidate call unexpectedly suspended');
  return pending.result;
}

function activation(
  mainAgentId: string,
  agentId: string,
  browser: BrowserHostRuntime,
): ToolActivationContext {
  return {
    agentType: 'worker',
    agentSpec: 'browser-skill-builder',
    agentId,
    mainAgentId,
    runConfig: { name: mainAgentId, description: '', promptTemplate: '' },
    resourceIds: { browserId: 'browser-1' },
    currentModel: () => 'provider::model',
    workspace: { dir: process.cwd(), tempDir: tmpdir() },
    modes: { modeId: () => 'normal', approvalMode: () => 'auto' },
    browser,
    post: () => true,
  };
}

function toolContext(
  mainAgentId: string,
  agentSpecName: string,
  browser: BrowserHostRuntime,
  agentId = `${agentSpecName}-runtime`,
): ToolContext {
  const main = agentSpecName === 'director' || agentSpecName === 'browser-skill-director';
  return {
    agentId,
    callId: `${agentSpecName}-call`,
    workspace: { dir: process.cwd(), tempDir: tmpdir() },
    signal: new AbortController().signal,
    declareTerminal: vi.fn(),
    post: vi.fn(() => true),
    log: vi.fn(),
    agentType: main ? 'main' : 'worker',
    agentSpec: agentSpecName,
    mainAgentId,
    runConfig: {
      name: mainAgentId,
      description: '',
      promptTemplate: '',
    },
    ...(main
      ? {}
      : {
          subagentConfig: {
            mode: 'browser',
            subject: agentSpecName,
            taskIds: ['task-1'],
            prompt: 'test',
            agentSpec: agentSpecName,
          },
        }),
    resourceIds: { browserId: 'browser-1' },
    currentModel: 'provider::model',
    modes: { modeId: () => 'normal', approvalMode: () => 'auto' },
    browser,
  };
}

function browserRuntime(): BrowserHostRuntime {
  const generated = {
    page: {
      currentPage: vi.fn(async () => ({
        url: 'https://example.test/current',
        title: 'Candidate page',
      })),
    },
  } as unknown as GeneratedBrowserSkillRuntime;
  return {
    domain: 'browser',
    core: {} as BrowserHostRuntime['core'],
    notifyPageOpen: vi.fn(),
    createGeneratedRuntime: vi.fn(() => generated),
    prepareScreenshot: vi.fn(),
    finalizeScreenshot: vi.fn(),
    cleanupScreenshot: vi.fn(),
  };
}

function workflowBrowserRuntime(): {
  browser: BrowserHostRuntime;
  page: {
    fill: ReturnType<typeof vi.fn>;
    click: ReturnType<typeof vi.fn>;
    waitFor: ReturnType<typeof vi.fn>;
    extractList: ReturnType<typeof vi.fn>;
    extractText: ReturnType<typeof vi.fn>;
  };
} {
  const observation = { url: 'https://example.test/results', title: 'Results' };
  const page = {
    navigate: vi.fn(async () => observation),
    currentPage: vi.fn(async () => observation),
    click: vi.fn(async () => observation),
    fill: vi.fn(async () => observation),
    select: vi.fn(async () => observation),
    press: vi.fn(async () => observation),
    waitFor: vi.fn(async () => observation),
    extractText: vi.fn(async () => 'offer-42'),
    extractList: vi.fn(async () => [{ selectionKey: 'offer-42', summary: 'Nonstop option' }]),
  };
  const generated = { page } as unknown as GeneratedBrowserSkillRuntime;
  return {
    page,
    browser: {
      domain: 'browser',
      core: {} as BrowserHostRuntime['core'],
      notifyPageOpen: vi.fn(),
      createGeneratedRuntime: vi.fn(() => generated),
      prepareScreenshot: vi.fn(),
      finalizeScreenshot: vi.fn(),
      cleanupScreenshot: vi.fn(),
    },
  };
}

function installedSkill() {
  return attachSkillProvenance(defineSkill({
    name: SKILL,
    domain: 'browser',
    functions: {
      inspect: {
        description: 'Installed inspect function',
        params: z.object({ suffix: z.string() }),
        async run({ suffix }) {
          return { ok: true as const, text: JSON.stringify({ version: 'installed', suffix }) };
        },
      },
    },
  }), {
    root: '/installed/candidate-demo',
    trust: 'custom',
    entryPoint: 'skill_call',
  });
}

function installedTeachingPort(skill: ReturnType<typeof installedSkill>) {
  return {
    getLoadedSkillModule: (name: string) => name === SKILL ? skill : undefined,
    classifySkill: vi.fn(async () => 'unknown' as const),
    getSkillDocs: vi.fn(async () => '# Installed teaching\n\nUse the installed function.'),
    getSkillResourceRoot: vi.fn(() => '/installed/candidate-demo'),
    listManagedSkills: vi.fn(async () => [{ name: SKILL, enabled: true }]),
  };
}

function nativeTool(name: string): ITool<Record<string, never>> {
  return {
    def: {
      name,
      description: name,
      schema: z.object({}),
      scope: 'shared',
      effects: [],
    },
    async execute() {
      return { ok: true, text: name };
    },
  };
}

async function writeBrowserSkill(
  dir: string,
  version: string,
  options: {
    invalidSdkCall?: boolean;
    reservedFunction?: boolean;
    hostParameter?: boolean;
  } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${SKILL}`,
    'type: browser',
    `description: Candidate ${version} for example.test browser operations`,
    '---',
    '',
    `# Candidate ${version}`,
    '',
    'Use inspect before continuing.',
    '',
  ].join('\n'), 'utf8');

  const inspectBody = options.invalidSdkCall
    ? "await ctx.browser.page.magicClick(); return ok('unreachable')"
    : `const page = await ctx.browser.page.currentPage()
        return ok(JSON.stringify({ version: ${JSON.stringify(version)}, suffix, url: page.url }))`;
  const reserved = options.reservedFunction
    ? `
      reserved: {
        description: 'Reserved conflict',
        params: z.object({}),
        async run() { return ok('reserved') },
      },`
    : '';

  await writeFile(path.join(dir, 'skill.ts'), [
    "import { defineSkill, ok, z } from 'piskiepilot/core-skill'",
    '',
    'export default defineSkill({',
    `  name: ${JSON.stringify(SKILL)},`,
    "  domain: 'browser',",
    '  functions: {',
    '    inspect: {',
    `      description: ${JSON.stringify(`Inspect current page and return ${version}`)},`,
    options.hostParameter
      ? "      params: z.object({ suffix: z.string(), browserId: z.string() }),"
      : "      params: z.object({ suffix: z.string().describe('Caller marker') }),",
    '      async run({ suffix }, ctx) {',
    `        ${inspectBody}`,
    '      },',
    '    },',
    '    candidateOnly: {',
    "      description: 'Candidate-only function',",
    '      params: z.object({}),',
    `      async run() { return ok(${JSON.stringify(version)}) },`,
    '    },',
    reserved,
    '  },',
    '})',
    '',
  ].join('\n'), 'utf8');
}

async function writeComposableBrowserSkill(
  dir: string,
  version: string,
  options: { selectionFails?: boolean } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${SKILL}`,
    'type: browser',
    `description: Search and select example.test options (${version})`,
    '---',
    '',
    `# Composable candidate ${version}`,
    '',
    'Call searchOptions, choose one options[].selectionKey from its returned text, then pass that exact value to selectOption.',
    '',
  ].join('\n'), 'utf8');

  const selectBody = options.selectionFails
    ? `return fail(JSON.stringify({
          stage: 'select-option',
          pageState: 'results-ready',
          error: 'selection control changed',
          recovery: 'inspect the current result item and rebuild this function',
        }))`
    : `const page = ctx.browser.page
        await page.click({ css: \`[data-selection-key="\${selectionKey}"]\` })
        await page.waitFor({ text: 'Selected' })
        const selected = await page.extractText({
          locator: { css: '[data-selected-key]' },
          attribute: 'data-selected-key',
        })
        return ok(JSON.stringify({ state: 'option-selected', selectionKey: selected ?? selectionKey }))`;

  await writeFile(path.join(dir, 'skill.ts'), [
    "import { defineSkill, fail, ok, z } from 'piskiepilot/core-skill'",
    '',
    'export default defineSkill({',
    `  name: ${JSON.stringify(SKILL)},`,
    "  domain: 'browser',",
    '  functions: {',
    '    searchOptions: {',
    "      description: 'Search options and return options[].selectionKey plus summary in model-visible text.',",
    "      params: z.object({ query: z.string().describe('User-visible search terms') }),",
    '      async run({ query }, ctx) {',
    '        const page = ctx.browser.page',
    "        await page.fill({ role: 'textbox', name: 'Search' }, query)",
    "        await page.click({ role: 'button', name: 'Search' })",
    "        await page.waitFor({ locator: { css: '[data-result-item]' } })",
    '        const options = await page.extractList({',
    "          items: { css: '[data-result-item]' },",
    '          fields: {',
    "            selectionKey: { attribute: 'data-selection-key' },",
    "            summary: { text: 'self' },",
    '          },',
    '        })',
    "        return ok(JSON.stringify({ state: 'results-ready', options }))",
    '      },',
    '    },',
    '    selectOption: {',
    `      description: ${JSON.stringify(`Select one search result using options[].selectionKey (${version}).`)},`,
    "      params: z.object({ selectionKey: z.string().describe('Exact options[].selectionKey returned by searchOptions') }),",
    '      async run({ selectionKey }, ctx) {',
    `        ${selectBody}`,
    '      },',
    '    },',
    '  },',
    '})',
    '',
  ].join('\n'), 'utf8');
}
