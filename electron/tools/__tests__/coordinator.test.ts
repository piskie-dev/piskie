import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

import { ToolCallContextFactory, type ToolActivationContext } from '../../agent/tool-call/context-builder.js';
import { Settler, type SettlementConversation } from '../../agent/conversation/settler.js';
import { ToolCatalog, type CatalogIdentity, type FinalToolFace } from '../catalog.js';
import { ToolCoordinator, type SkillInventoryPort } from '../coordinator.js';
import { z } from '../params.js';
import { REJECT } from '../pipeline/rejections.js';
import { SkillCallTool } from '../skill/skill-call.tool.js';
import { ShellTool } from '../shell/shell.tool.js';
import { BackgroundRegistry } from '../state/background-registry.js';
import type {
  ITool,
  ToolContext,
  ToolDef,
  ToolOutput,
} from '../types.js';

const LOCAL_FACE: FinalToolFace = {
  scope: 'subagent',
  agentType: 'worker',
  customTools: ['skill_call'],
  exposedSkillFunctions: [],
  excluded: new Set(),
  domains: new Set(['local']),
};

const observer = {
  start: vi.fn(),
  finish: vi.fn(),
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

function activation(approvalMode: 'auto' | 'confirm' = 'auto'): ToolActivationContext {
  return {
    agentType: 'worker',
    agentSpec: 'local-worker',
    agentId: 'agent-1',
    mainAgentId: 'main-1',
    runConfig: { name: 'run', description: '', promptTemplate: '' },
    resourceIds: {},
    currentModel: () => 'provider::model',
    workspace: { dir: '/workspace', tempDir: '/tmp/agent-1' },
    modes: { modeId: () => 'normal', approvalMode: () => approvalMode },
    post: () => true,
  };
}

function contextFactory(approvalMode: 'auto' | 'confirm' = 'auto'): ToolCallContextFactory {
  return new ToolCallContextFactory({
    activation: activation(approvalMode),
    signal: () => new AbortController().signal,
  });
}

function makeTool<T extends Record<string, unknown>>(
  def: ToolDef<T>,
  execute: (params: T, ctx: ToolContext) => Promise<ToolOutput<unknown>>,
): ITool<T, unknown> {
  return { def, execute };
}

function emptyTool(
  name: string,
  options: Partial<Pick<ToolDef<Record<string, never>>, 'scope' | 'effects'>> = {},
): ITool<Record<string, never>> {
  return makeTool({
    name,
    description: name,
    schema: z.object({}),
    scope: options.scope ?? 'shared',
    effects: options.effects ?? [],
  }, async () => ({ ok: true, text: name }));
}

function registerSelector(catalog: ToolCatalog): void {
  catalog.register(new SkillCallTool(), 'builtin');
}

type SkillIdentity = Extract<CatalogIdentity, { kind: 'skill' }>;

function registerSkillTool<TParams, TData>(
  catalog: ToolCatalog,
  tool: ITool<TParams, TData>,
  identity: Omit<SkillIdentity, 'kind' | 'entryPoint'> & { entryPoint?: SkillIdentity['entryPoint'] },
  trust: 'builtin' | 'custom' = 'custom',
): void {
  catalog.register(tool, trust, {
    ...identity,
    kind: 'skill',
    entryPoint: identity.entryPoint ?? 'skill_call',
  });
}

describe('ToolCoordinator parameter boundary', () => {
  it('records raw model parameters while execute receives normalized optional values', async () => {
    const rawParams = { required: 'value', optional: 'undefined' };
    const execute = vi.fn(async () => ({ ok: true, text: 'done' }));
    const tool = makeTool({
      name: 'optional-probe',
      description: 'probe',
      schema: z.object({ required: z.string(), optional: z.string().optional() }),
      scope: 'shared',
      effects: [],
    }, execute);
    const catalog = new ToolCatalog();
    catalog.register(tool, 'builtin');
    const callObserver = { start: vi.fn(), finish: vi.fn() };
    const coordinator = new ToolCoordinator({ contexts: contextFactory(), observer: callObserver });
    const snapshot = catalog.snapshot({
      ...LOCAL_FACE,
      customTools: ['optional-probe'],
    });

    await coordinator.run({ modelName: 'optional-probe', rawParams, callId: 'probe-1' }, snapshot);

    expect(callObserver.start).toHaveBeenCalledWith(expect.objectContaining({ rawParams }));
    expect(execute).toHaveBeenCalledWith({ required: 'value' }, expect.anything());
    expect(rawParams).toEqual({ required: 'value', optional: 'undefined' });
  });

  it('persists oversized output from a non-streaming tool through the shared finalizer', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-tool-output-'));
    temporaryDirectories.push(tempDir);
    const contexts = new ToolCallContextFactory({
      activation: { ...activation(), workspace: { dir: '/workspace', tempDir } },
      signal: () => new AbortController().signal,
    });
    const tool = makeTool({
      name: 'large-snapshot',
      description: 'large snapshot',
      schema: z.object({}),
      scope: 'shared',
      effects: [],
    }, async () => ({ ok: true, text: 'x'.repeat(64 * 1024 + 1) }));
    const catalog = new ToolCatalog();
    catalog.register(tool, 'builtin');
    const coordinator = new ToolCoordinator({ contexts, observer });

    const pending = await coordinator.run({
      modelName: 'large-snapshot',
      rawParams: {},
      callId: 'snapshot-1',
    }, catalog.snapshot({ ...LOCAL_FACE, customTools: ['large-snapshot'] }));

    expect('suspended' in pending).toBe(false);
    if ('suspended' in pending) return;
    expect(pending.result.persisted).toMatchObject({ bytes: 64 * 1024 + 1 });
    expect(await fs.readFile(pending.result.persisted!.path, 'utf8')).toBe(pending.result.text);
  });

  it('starts tool timing only after approval and ends it when execute returns', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    try {
      let resolveApproval!: (decision: { callId: string; decision: 'allow' }) => void;
      let approvalRequested!: () => void;
      const requested = new Promise<void>((resolve) => {
        approvalRequested = resolve;
      });
      const approval = new Promise<{ callId: string; decision: 'allow' }>((resolve) => {
        resolveApproval = resolve;
      });
      const request = vi.fn(() => {
        approvalRequested();
        return approval;
      });
      const execute = vi.fn(async () => {
        vi.setSystemTime(32_000);
        return { ok: true, text: 'done' };
      });
      const tool = makeTool({
        name: 'approval-probe',
        description: 'approval probe',
        schema: z.object({}),
        scope: 'shared',
        effects: ['exec'],
      }, execute);
      const catalog = new ToolCatalog();
      catalog.register(tool, 'builtin');
      const callObserver = {
        start: vi.fn(),
        executionStarted: vi.fn(),
        executionFinished: vi.fn(),
        finish: vi.fn(),
      };
      const coordinator = new ToolCoordinator({
        contexts: contextFactory('confirm'),
        observer: callObserver,
        pipeline: { approval: { request } },
      });

      const running = coordinator.run(
        { modelName: 'approval-probe', rawParams: {}, callId: 'approval-1' },
        catalog.snapshot({ ...LOCAL_FACE, customTools: ['approval-probe'] }),
      );
      await requested;

      vi.setSystemTime(30_000);
      expect(execute).not.toHaveBeenCalled();
      expect(callObserver.executionStarted).not.toHaveBeenCalled();
      resolveApproval({ callId: 'approval-1', decision: 'allow' });
      await running;

      expect(callObserver.executionStarted).toHaveBeenCalledWith(
        expect.objectContaining({ callId: 'approval-1' }),
        30_000,
      );
      expect(callObserver.executionFinished).toHaveBeenCalledWith(
        expect.objectContaining({ callId: 'approval-1' }),
        { startedAt: 30_000, finishedAt: 32_000 },
      );
      expect(callObserver.finish).toHaveBeenCalledWith(expect.objectContaining({
        intervals: [{ startedAt: 30_000, finishedAt: 32_000 }],
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not create an execution interval for ask_user', async () => {
    const tool = emptyTool('ask_user');
    const catalog = new ToolCatalog();
    catalog.register(tool, 'builtin');
    const callObserver = {
      start: vi.fn(),
      executionStarted: vi.fn(),
      executionFinished: vi.fn(),
      finish: vi.fn(),
    };
    const coordinator = new ToolCoordinator({ contexts: contextFactory(), observer: callObserver });

    await coordinator.run(
      { modelName: 'ask_user', rawParams: {}, callId: 'ask-1' },
      catalog.snapshot({ ...LOCAL_FACE, customTools: ['ask_user'] }),
    );

    expect(callObserver.executionStarted).not.toHaveBeenCalled();
    expect(callObserver.executionFinished).not.toHaveBeenCalled();
    expect(callObserver.finish).toHaveBeenCalledWith(expect.objectContaining({ intervals: [] }));
  });

  it('ends a promoted shell interval while the adopted background process is still alive', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-tool-shell-timing-'));
    temporaryDirectories.push(tempDir);
    const background = new BackgroundRegistry();
    const contexts = new ToolCallContextFactory({
      activation: { ...activation(), workspace: { dir: tempDir, tempDir } },
      signal: () => new AbortController().signal,
      background,
    });
    const catalog = new ToolCatalog();
    catalog.register(new ShellTool(), 'builtin');
    const callObserver = {
      start: vi.fn(),
      executionStarted: vi.fn(),
      executionFinished: vi.fn(),
      finish: vi.fn(),
    };
    const coordinator = new ToolCoordinator({ contexts, observer: callObserver });

    try {
      const running = coordinator.run({
        modelName: 'shell',
        rawParams: { command: 'sleep 30', timeout: 600_000, run_in_background: false },
        callId: 'promoted-shell',
      }, catalog.snapshot({ ...LOCAL_FACE, customTools: ['shell'] }));

      await vi.waitFor(() => expect(background.promote('promoted-shell')).toBe(true));
      await running;

      expect(background.hasActiveJobs()).toBe(true);
      expect(callObserver.executionFinished).toHaveBeenCalledOnce();
      expect(callObserver.finish).toHaveBeenCalledWith(expect.objectContaining({
        intervals: [expect.objectContaining({
          startedAt: expect.any(Number),
          finishedAt: expect.any(Number),
        })],
      }));
    } finally {
      await background.dispose();
    }
  });
});

describe('ToolCoordinator skill_call selection', () => {
  it('fixes the target before context construction and runs the target pipeline exactly once', async () => {
    const catalog = new ToolCatalog();
    registerSelector(catalog);

    let targetParses = 0;
    const editExecute = vi.fn(async (
      params: { file_path: string; text: string },
      ctx: ToolContext,
    ): Promise<ToolOutput<unknown>> => {
      expect(ctx.files).toBeDefined();
      return { ok: true, text: `${params.file_path}:${params.text}` };
    });
    const edit = makeTool({
      name: 'demo-skill_editText',
      description: 'Edit text',
      schema: z.object({
        file_path: z.string(),
        text: z.preprocess((value) => {
          targetParses += 1;
          return value;
        }, z.string()),
      }),
      scope: 'shared',
      effects: ['write-fs'],
      policy: { mutation: { pathParam: 'file_path', priorRead: 'none' } },
    }, editExecute);
    registerSkillTool(catalog, edit, {
      skill: 'demo-skill', function: 'editText', domain: 'local',
    });

    const inspectExecute = vi.fn(async (
      _params: Record<string, never>,
      ctx: ToolContext,
    ): Promise<ToolOutput<unknown>> => {
      expect(ctx.files).toBeUndefined();
      return { ok: true, text: 'inspected' };
    });
    registerSkillTool(catalog, makeTool({
      name: 'demo-skill_inspect',
      description: 'Inspect',
      schema: z.object({}),
      scope: 'shared',
      effects: ['read-fs'],
    }, inspectExecute), {
      skill: 'demo-skill', function: 'inspect', domain: 'local',
    });

    const contexts = contextFactory();
    const create = vi.spyOn(contexts, 'create');
    const request = vi.fn(async ({ call }: Parameters<NonNullable<ConstructorParameters<typeof ToolCoordinator>[0]['pipeline']>['approval']['request']>[0]) => ({
      callId: call.callId,
      decision: 'allow' as const,
    }));
    const coordinator = new ToolCoordinator({
      contexts,
      observer,
      pipeline: { approval: { request } },
    });
    const snapshot = catalog.snapshot(LOCAL_FACE);

    const pending = await coordinator.run({
      modelName: 'skill_call',
      rawParams: {
        skill: 'demo-skill',
        function: 'editText',
        args: { file_path: '/workspace/a.txt', text: 'next', ignored: true },
      },
      callId: 'model-call-1',
    }, snapshot);

    expect('suspended' in pending).toBe(false);
    if ('suspended' in pending) return;
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].modelName).toBe('demo-skill_editText');
    expect(create.mock.calls[0][0].modelName).not.toBe('skill_call');
    expect(create.mock.calls[0][3]).toBe(snapshot);
    // Auto applies to custom Skill functions through the same policy as every other tool.
    expect(request).not.toHaveBeenCalled();
    expect(targetParses).toBe(1);
    expect(editExecute).toHaveBeenCalledOnce();
    expect(editExecute.mock.calls[0][0]).toEqual({
      file_path: '/workspace/a.txt',
      text: 'next',
    });
    expect(pending).toMatchObject({
      callId: 'model-call-1',
      toolName: 'demo-skill_editText',
      result: { ok: true, text: '/workspace/a.txt:next' },
    });

    const appendLiveToolResult = vi.fn();
    let settled = false;
    const conversation: SettlementConversation = {
      resolve: () => settled ? 'already_settled' : 'insertable',
      appendLiveToolResult: (...args) => {
        settled = true;
        appendLiveToolResult(...args);
      },
      appendRecoveryToolResult: vi.fn(),
      appendSystemMessage: vi.fn(),
    };
    const settler = new Settler(
      conversation,
      () => undefined,
    );
    expect(pending.commit(settler).settled).toBe('inserted');
    expect(pending.commit(settler).settled).toBe('already_settled');
    expect(appendLiveToolResult).toHaveBeenCalledOnce();

    await coordinator.run({
      modelName: 'skill_call',
      rawParams: { skill: 'demo-skill', function: 'inspect', args: {} },
      callId: 'model-call-2',
    }, snapshot);
    expect(create.mock.calls[1][0].modelName).toBe('demo-skill_inspect');
    expect(inspectExecute).toHaveBeenCalledOnce();
  });

  it('preserves every selector rejection reason without constructing a context', async () => {
    const catalog = new ToolCatalog();
    registerSelector(catalog);
    registerSkillTool(catalog, emptyTool('fixed_run'), {
      skill: 'fixed', function: 'run', domain: 'local', entryPoint: 'direct',
    }, 'builtin');
    registerSkillTool(catalog, emptyTool('browser-skill_run'), {
      skill: 'browser-skill', function: 'run', domain: 'browser',
    });
    registerSkillTool(catalog, emptyTool('main-skill_run', { scope: 'main' }), {
      skill: 'main-skill', function: 'run', domain: 'local',
    });
    registerSkillTool(catalog, emptyTool('excluded-skill_run'), {
      skill: 'excluded-skill', function: 'run', domain: 'local',
    });

    const contexts = contextFactory();
    const create = vi.spyOn(contexts, 'create');
    const coordinator = new ToolCoordinator({ contexts, observer });
    const cases = [
      {
        face: { ...LOCAL_FACE, exposedSkillFunctions: ['fixed_run'] },
        skill: 'fixed',
        functionName: 'run',
        text: REJECT.directOnly('fixed_run'),
      },
      {
        face: LOCAL_FACE,
        skill: 'fixed',
        functionName: 'run',
        text: REJECT.notEligible('fixed', 'run', 'notExposed'),
      },
      {
        face: LOCAL_FACE,
        skill: 'browser-skill',
        functionName: 'run',
        text: REJECT.notEligible('browser-skill', 'run', 'resource'),
      },
      {
        face: LOCAL_FACE,
        skill: 'main-skill',
        functionName: 'run',
        text: REJECT.notEligible('main-skill', 'run', 'scope'),
      },
      {
        face: { ...LOCAL_FACE, excluded: new Set(['excluded-skill_run']) },
        skill: 'excluded-skill',
        functionName: 'run',
        text: REJECT.notEligible('excluded-skill', 'run', 'excluded'),
      },
      {
        face: LOCAL_FACE,
        skill: 'excluded-skill',
        functionName: 'missing',
        text: REJECT.unknownFunction('excluded-skill', 'missing', ['run']),
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const result = await coordinator.run({
        modelName: 'skill_call',
        rawParams: {
          skill: testCase.skill,
          function: testCase.functionName,
          args: {},
        },
        callId: `reject-${index}`,
      }, catalog.snapshot(testCase.face));
      expect('suspended' in result).toBe(false);
      if (!('suspended' in result)) expect(result.result).toEqual({ ok: false, text: testCase.text });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('classifies only not-callable Skills through the installed inventory', async () => {
    const catalog = new ToolCatalog();
    registerSelector(catalog);
    const classify = vi.fn<SkillInventoryPort['classify']>(async (skill) => ({
      'standard-skill': 'standard' as const,
      'disabled-skill': 'disabled' as const,
    })[skill] ?? 'unknown');
    const contexts = contextFactory();
    const create = vi.spyOn(contexts, 'create');
    const coordinator = new ToolCoordinator({
      contexts,
      observer,
      skills: { classify },
    });
    const snapshot = catalog.snapshot(LOCAL_FACE);

    const cases = [
      ['standard-skill', REJECT.standardSkill('standard-skill')],
      ['disabled-skill', REJECT.disabledSkill('disabled-skill')],
      ['missing-skill', REJECT.unknownSkill('missing-skill')],
    ] as const;
    for (const [index, [skill, text]] of cases.entries()) {
      const result = await coordinator.run({
        modelName: 'skill_call',
        rawParams: { skill, function: 'run', args: {} },
        callId: `classification-${index}`,
      }, snapshot);
      expect('suspended' in result).toBe(false);
      if (!('suspended' in result)) expect(result.result).toEqual({ ok: false, text });
    }

    expect(classify.mock.calls.map(([skill]) => skill)).toEqual([
      'standard-skill',
      'disabled-skill',
      'missing-skill',
    ]);
    expect(create).not.toHaveBeenCalled();
  });
});
