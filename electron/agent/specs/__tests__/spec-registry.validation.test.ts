import { describe, expect, it } from 'vitest';

import { deriveWorkerMode, SpecRegistry } from '../spec-registry.js';
import type { AgentSpec } from '../spec.js';

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  const { tools, ...rest } = overrides;
  return {
    name: 'test-spec',
    role: 'director',
    modules: [],
    buildSystemPrompt: () => '',
    ...rest,
    tools: {
      sdkGroups: tools?.sdkGroups ?? [],
      customTools: tools?.customTools ?? [],
      exclude: tools?.exclude,
      customToolGroups: tools?.customToolGroups,
    },
  };
}

function register(candidate: AgentSpec): void {
  new SpecRegistry().register(candidate);
}

describe('AgentSpec mode derivation', () => {
  it('derives local and browser only from final modules', () => {
    expect(deriveWorkerMode(spec({ name: 'local', role: 'worker' }))).toBe('local');
    expect(deriveWorkerMode(spec({ name: 'browser', role: 'worker', modules: ['browser'] }))).toBe('browser');
  });

  it('rejects directors', () => {
    expect(() => deriveWorkerMode(spec({ name: 'director' }))).toThrow(/not a Worker/);
  });

});

describe('AgentSpec registration invariants', () => {
  it.each(['', '', '.', '..', '../worker', 'group/worker', 'group\\worker']) (
    'rejects path-unsafe AgentSpec name %j',
    (name) => {
      expect(() => register(spec({ name }))).toThrow(/path-safe identifier/);
    },
  );

  it('resolves Worker Specs from an explicit override or the base Worker mode', () => {
    const registry = new SpecRegistry();

    expect(registry.resolveWorkerSpec({ mode: 'local' })).toBe('local-worker');
    expect(registry.resolveWorkerSpec({ mode: 'browser' })).toBe('browser-worker');
    expect(registry.resolveWorkerSpec({ mode: 'browser', agentSpec: 'custom-worker' }))
      .toBe('custom-worker');
  });

  it.each([
    ['browser module without SDK', spec({ name: 'browser-no-sdk', role: 'worker', modules: ['browser'] })],
    ['browser SDK without module', spec({
      name: 'browser-no-module', role: 'worker', tools: { sdkGroups: ['browser'], customTools: [] },
    })],
  ])('rejects %s', (_label, candidate) => {
    expect(() => register(candidate)).toThrow(/pair/);
  });

  it('rejects lifecycle on directors', () => {
    expect(() => register(spec({ name: 'director-lifecycle', lifecycle: { onTerminal: 'immediate' } })))
      .toThrow(/lifecycle/);
  });

  it('limits Director browser sharing to browser Workers', () => {
    expect(() => register(spec({ name: 'director-share', shareDirectorBrowser: true })))
      .toThrow(/requires a browser Worker/);
    expect(() => register(spec({
      name: 'local-share',
      role: 'worker',
      shareDirectorBrowser: true,
    }))).toThrow(/requires a browser Worker/);
    expect(() => register(spec({
      name: 'browser-share',
      role: 'worker',
      modules: ['browser'],
      tools: { sdkGroups: ['browser'], customTools: [] },
      shareDirectorBrowser: true,
    }))).not.toThrow();
  });

  it('requires the subagent tool/module pair and limits it to directors', () => {
    expect(() => register(spec({
      name: 'tool-only', tools: { sdkGroups: [], customTools: ['subagent'] },
    }))).toThrow(/pair/);
    expect(() => register(spec({ name: 'module-only', modules: ['subagent'] }))).toThrow(/pair/);
    expect(() => register(spec({
      name: 'worker-subagent',
      role: 'worker',
      modules: ['subagent'],
      tools: { sdkGroups: [], customTools: ['subagent'] },
    }))).toThrow(/director/);
  });

  it('limits protected Worker creation by parent AgentSpec without a special Assignment', () => {
    const registry = new SpecRegistry();
    const protectedWorker = spec({
      name: 'protected-worker',
      role: 'worker',
      allowedParentSpecs: ['special-director'],
      subagentTypeDescription: '执行受保护的专业任务',
    });
    registry.register(protectedWorker);

    expect(() => registry.assertParentMayCreate('special-director', protectedWorker)).not.toThrow();
    expect(() => registry.assertParentMayCreate('director', protectedWorker))
      .toThrow(/cannot create protected Worker/);
    expect(() => registry.assertParentMayCreate('director', spec({
      name: 'generic-worker',
      role: 'worker',
    }))).not.toThrow();
    expect(registry.getNamedWorkersForParent('special-director')).toEqual([
      { name: 'protected-worker', mode: 'local', description: '执行受保护的专业任务' },
    ]);
    expect(registry.getNamedWorkersForParent('director')).toEqual([]);
  });

  it('rejects invalid protected-Worker declarations', () => {
    expect(() => register(spec({
      name: 'director-with-parent-list',
      allowedParentSpecs: ['director'],
      subagentTypeDescription: 'invalid',
    }))).toThrow(/only valid for Worker/);
    expect(() => register(spec({
      name: 'empty-parent-list',
      role: 'worker',
      allowedParentSpecs: [],
      subagentTypeDescription: 'invalid',
    }))).toThrow(/non-empty/);
    expect(() => register(spec({
      name: 'duplicate-parent-list',
      role: 'worker',
      allowedParentSpecs: ['director', 'director'],
      subagentTypeDescription: 'invalid',
    }))).toThrow(/unique/);
    expect(() => register(spec({
      name: 'missing-type-description',
      role: 'worker',
      allowedParentSpecs: ['director'],
    }))).toThrow(/subagentTypeDescription/);
  });

  it('reserves Browser Skill build and publication tools for their dedicated specs', () => {
    for (const toolName of [
      'browser_skill_build',
      'browser_skill_status',
      'browser_skill_publish',
    ]) {
      expect(() => register(spec({
        name: `custom-${toolName.replaceAll('_', '-')}`,
        tools: { sdkGroups: [], customTools: [toolName] },
      }))).toThrow(/protected tool/);
    }

    expect(() => register(spec({
      name: 'browser-skill-director',
      tools: { sdkGroups: [], customTools: ['browser_skill_status', 'browser_skill_publish'] },
    }))).not.toThrow();
    expect(() => register(spec({
      name: 'browser-skill-builder',
      role: 'worker',
      tools: { sdkGroups: [], customTools: ['browser_skill_build'] },
    }))).not.toThrow();
  });

  it('limits agent_run to directors', () => {
    expect(() => register(spec({
      name: 'worker-agent-run',
      role: 'worker',
      tools: { sdkGroups: [], customTools: ['agent_run'] },
    }))).toThrow(/director/);
    expect(() => register(spec({
      name: 'agent-run-valid', tools: { sdkGroups: [], customTools: ['agent_run'] },
    }))).not.toThrow();
  });
});
