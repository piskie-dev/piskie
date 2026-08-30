import { describe, expect, it, vi } from 'vitest';
import {
  attachSkillProvenance,
  defineSkill,
  type DomainDescriptor,
} from '../../piskiepilot/core/skill/define.js';
import { ToolCatalog, type FinalToolFace } from '../catalog.js';
import { z } from '../params.js';
import { buildSkillEntries } from '../skill/register-skill-functions.js';
import { descriptorFor } from '../skill/domain-descriptors.js';
import type { ITool, ToolContext } from '../types.js';

const LOCAL_FACE: FinalToolFace = {
  scope: 'subagent',
  agentType: 'worker',
  customTools: ['native_tool', 'skill_call'],
  exposedSkillFunctions: ['fixed_read'],
  excluded: new Set(),
  domains: new Set(['local']),
};

function nativeTool(name: string, scope: 'main' | 'subagent' | 'shared' = 'shared'): ITool {
  return {
    def: {
      name,
      description: `${name} description`,
      schema: z.object({}),
      scope,
      effects: [],
    },
    async execute() {
      return { ok: true, text: name };
    },
  };
}

function fakeContext(signal = new AbortController().signal): ToolContext {
  return {
    agentId: 'agent-1',
    callId: 'call-1',
    workspace: { dir: '/workspace', tempDir: '/tmp/agent-1' },
    signal,
    declareTerminal: vi.fn(),
    post: vi.fn(() => true),
    agentType: 'worker',
    agentSpec: 'local-worker',
    mainAgentId: 'main-1',
    runConfig: {
      name: 'run',
      description: '',
      promptTemplate: '',
    },
    resourceIds: {},
    currentModel: 'provider::model',
    modes: { modeId: () => 'normal', approvalMode: () => 'auto' },
  };
}

describe('ToolCatalog snapshots', () => {
  it('uses one filtered view for definitions and direct resolution', () => {
    const catalog = new ToolCatalog();
    catalog.register(nativeTool('native_tool'), 'builtin');
    catalog.register(nativeTool('hidden_tool'), 'builtin');
    const snapshot = catalog.snapshot(LOCAL_FACE);

    expect(snapshot.definitions().map((definition) => definition.name)).toEqual(['native_tool']);
    expect(snapshot.resolve('native_tool')?.modelName).toBe('native_tool');
    expect(snapshot.resolve('hidden_tool')).toBeUndefined();
  });

  it('closes over functions and applies descriptor policy/context', async () => {
    const controller = new AbortController();
    const seenSignal = vi.fn();
    const skill = defineSkill({
      name: 'executable-demo',
      domain: 'local',
      functions: {
        editText: {
          description: 'Edit text',
          params: z.object({ file_path: z.string(), text: z.string() }),
          async run(params, ctx) {
            seenSignal(ctx.signal);
            return { ok: true, text: `${params.file_path}:${params.text}` };
          },
        },
        inspect: {
          description: 'Inspect',
          params: z.object({ query: z.string() }),
          async run(params) {
            return { ok: true, text: params.query };
          },
        },
      },
    });
    const loaded = attachSkillProvenance(skill, {
      root: '/user/skills',
      trust: 'custom',
      entryPoint: 'skill_call',
    });
    const descriptor: DomainDescriptor<'local', typeof loaded.functions> = {
      domain: 'local',
      scope: 'shared',
      effects: ['write-fs'],
      policy: {
        editText: { mutation: { pathParam: 'file_path', priorRead: 'required' } },
      },
      makeContext(ctx) {
        return {
          signal: ctx.signal,
          taskId: ctx.agentId,
          executorId: ctx.agentId,
          log: vi.fn(),
        };
      },
    };

    const entries = buildSkillEntries(loaded, descriptor);
    const catalog = new ToolCatalog();
    catalog.replaceSkill(loaded.name, loaded.provenance, entries);
    const snapshot = catalog.snapshot(LOCAL_FACE);
    const resolution = snapshot.resolveSkillFunction('executable-demo', 'editText');
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') return;

    expect(resolution.entry.trust).toBe('custom');
    expect(resolution.entry.tool.def.policy?.mutation?.pathParam).toBe('file_path');
    const inspect = snapshot.resolveSkillFunction('executable-demo', 'inspect');
    expect(inspect.kind === 'resolved' && inspect.entry.tool.def.policy).toBeUndefined();
    await resolution.entry.tool.execute(
      { file_path: '/workspace/a', text: 'next' },
      fakeContext(controller.signal),
    );
    expect(seenSignal).toHaveBeenCalledWith(controller.signal);
  });

  it('derives trusted descriptor access from loader provenance, not a controllable name', () => {
    const skill = defineSkill({
      name: 'browser',
      domain: 'browser',
      functions: {
        takeScreenshot: {
          description: 'Take a screenshot',
          params: z.object({}),
          async run() {
            return { ok: true, text: 'ok' };
          },
        },
      },
    });
    const builtin = attachSkillProvenance(skill, {
      root: '/app/browser-skills',
      trust: 'builtin',
      entryPoint: 'direct',
    });
    const sameNameCustom = attachSkillProvenance(skill, {
      root: '/user/browser-skills',
      trust: 'custom',
      entryPoint: 'skill_call',
    });

    expect(descriptorFor(builtin).effects).toEqual(['read-fs', 'write-fs']);
    expect(descriptorFor(builtin).wrapExecute).toBeDefined();
    expect(descriptorFor(sameNameCustom).effects).toEqual(['read-fs', 'write-fs', 'exec']);
    expect(descriptorFor(sameNameCustom).wrapExecute).toBeDefined();

    const unknownBuiltin = attachSkillProvenance(
      defineSkill({
        name: 'undeclared-core',
        domain: 'local',
        functions: {
          run: {
            description: 'run',
            params: z.object({}),
            async run() { return { ok: true, text: 'ok' }; },
          },
        },
      }),
      { root: '/app/local-skills', trust: 'builtin', entryPoint: 'direct' },
    );
    expect(() => descriptorFor(unknownBuiltin)).toThrow(/Missing trusted DomainDescriptor/);
  });

  it('keeps direct and selector entry points mutually exclusive', () => {
    const catalog = new ToolCatalog();
    catalog.register(nativeTool('fixed_read'), 'builtin', {
      kind: 'skill',
      skill: 'fixed',
      function: 'read',
      domain: 'local',
      entryPoint: 'direct',
    });
    const visible = catalog.snapshot(LOCAL_FACE);
    expect(visible.resolveSkillFunction('fixed', 'read')).toEqual({
      kind: 'directOnly',
      modelName: 'fixed_read',
    });

    const hidden = catalog.snapshot({ ...LOCAL_FACE, exposedSkillFunctions: [] });
    expect(hidden.resolveSkillFunction('fixed', 'read')).toEqual({
      kind: 'notEligible',
      reason: 'notExposed',
    });
  });

  it('reports each selector eligibility failure without an index copy', () => {
    const catalog = new ToolCatalog();
    catalog.register(nativeTool('dynamic_run', 'main'), 'custom', {
      kind: 'skill',
      skill: 'dynamic',
      function: 'run',
      domain: 'browser',
      entryPoint: 'skill_call',
    });

    expect(catalog.snapshot(LOCAL_FACE).resolveSkillFunction('dynamic', 'run')).toEqual({
      kind: 'notEligible', reason: 'scope',
    });
    expect(catalog.snapshot({ ...LOCAL_FACE, scope: 'main' }).resolveSkillFunction('dynamic', 'run'))
      .toEqual({ kind: 'notEligible', reason: 'resource' });
    expect(catalog.snapshot({
      ...LOCAL_FACE,
      scope: 'main',
      domains: new Set(['local', 'browser']),
      excluded: new Set(['dynamic_run']),
    }).resolveSkillFunction('dynamic', 'run')).toEqual({ kind: 'notEligible', reason: 'excluded' });
    expect(catalog.snapshot({
      ...LOCAL_FACE,
      scope: 'main',
      domains: new Set(['local', 'browser']),
    }).resolveSkillFunction('dynamic', 'missing')).toEqual({
      kind: 'unknownFunction', available: ['run'],
    });
    expect(catalog.snapshot(LOCAL_FACE).resolveSkillFunction('missing', 'run'))
      .toEqual({ kind: 'notCallable' });
  });

  it('rejects cross-entry-point replacement without changing old entries', () => {
    const catalog = new ToolCatalog();
    catalog.register(nativeTool('browser_open'), 'builtin', {
      kind: 'skill',
      skill: 'browser',
      function: 'open',
      domain: 'browser',
      entryPoint: 'direct',
    });
    const replacement = [{
      tool: nativeTool('browser_open'),
      identity: {
        kind: 'skill' as const,
        skill: 'browser',
        function: 'open',
        domain: 'browser' as const,
        entryPoint: 'skill_call' as const,
      },
    }];

    expect(() => catalog.validateSkillReplacement('browser', {
      root: '/user/skills', trust: 'custom', entryPoint: 'skill_call',
    }, replacement)).toThrow(/entry point|conflict/);
    expect(catalog.snapshot({
      ...LOCAL_FACE,
      exposedSkillFunctions: ['browser_open'],
      domains: new Set(['local', 'browser']),
    }).resolve('browser_open')?.trust).toBe('builtin');
  });
});
