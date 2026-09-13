/**
 * 并行模式下的工具批次分组：按声明的 effects 判定并发安全。
 * - 只读（read-fs / external / 空）连续调用合成一组并行；
 * - 写类（write-fs / exec / agent-control）各自成组，按发出顺序串行；
 * - 组间检查中断，未启动的组写 not_started；
 * - 目录里解析不到的工具视为安全；skill_call 按实际函数的 effects 判定。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

import type { AgentControlState, ConversationEntry } from '../../../shared/types/agent-control.js';
import type { AgentInputEvent, ContentBlock } from '../../../shared/types/index.js';
import type { CatalogSnapshot, ResolvedCatalogEntry } from '../../tools/catalog.js';
import type { ToolEffect } from '../../tools/types.js';
import { AgentEngine, type ExecuteToolsOptions, type TurnOutcome } from '../agent-engine.js';
import { PendingSettlement } from '../tool-call/pending-settlement.js';
import { groupByConcurrencySafety, isConcurrencySafe } from '../tool-call/tool-concurrency.js';

function entryWith(name: string, effects: readonly ToolEffect[]): ResolvedCatalogEntry {
  return { modelName: name, tool: { def: { name, effects } } } as unknown as ResolvedCatalogEntry;
}

/** 只回答"这个名字声明了什么 effects"的目录快照 */
function snapshotOf(
  effectsByName: Record<string, readonly ToolEffect[]>,
  skillFunctions: Record<string, readonly ToolEffect[]> = {},
): CatalogSnapshot {
  return {
    resolve: (name) => (name in effectsByName ? entryWith(name, effectsByName[name]) : undefined),
    resolveDeferred: () => undefined,
    definitions: () => [],
    deferredTools: () => [],
    resolveSkillFunction: (skill, fn) => {
      const key = `${skill}.${fn}`;
      return key in skillFunctions
        ? { kind: 'resolved', entry: entryWith(key, skillFunctions[key]) }
        : { kind: 'notCallable' };
    },
  };
}

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'tool_use', id, name, input }) as unknown as ContentBlock;

const CATALOG = snapshotOf({
  read: ['read-fs'],
  grep: ['read-fs'],
  web_search: ['external'],
  ask_user: [],
  edit: ['read-fs', 'write-fs'],
  write: ['write-fs'],
  shell: ['exec'],
  subagent: ['agent-control'],
  skill_call: [],
}, {
  'demo.inspect': ['read-fs'],
  'demo.mutate': ['read-fs', 'write-fs'],
});

describe('isConcurrencySafe', () => {
  it('只读、外部与无 effects 的工具安全；写类、exec、agent-control 不安全', () => {
    const safe = (name: string) => isConcurrencySafe(toolUse('x', name), CATALOG, new Set());
    expect(safe('read')).toBe(true);
    expect(safe('web_search')).toBe(true);
    expect(safe('ask_user')).toBe(true);
    expect(safe('edit')).toBe(false);
    expect(safe('write')).toBe(false);
    expect(safe('shell')).toBe(false);
    expect(safe('subagent')).toBe(false);
  });

  it('目录里解析不到的工具视为安全（协调器会打回，无副作用）', () => {
    expect(isConcurrencySafe(toolUse('x', 'nope'), CATALOG, new Set())).toBe(true);
  });

  it('skill_call 按实际函数的 effects 判定；解析不到时视为安全', () => {
    const call = (skill: string, fn: string) =>
      isConcurrencySafe(toolUse('x', 'skill_call', { skill, function: fn }), CATALOG, new Set());
    expect(call('demo', 'inspect')).toBe(true);
    expect(call('demo', 'mutate')).toBe(false);
    expect(call('demo', 'missing')).toBe(true);
  });

  it('已装载的 deferred 工具按 resolveDeferred 的 effects 判定', () => {
    const snapshot: CatalogSnapshot = {
      ...CATALOG,
      resolveDeferred: (name) => (name === 'mcp_write' ? entryWith(name, ['external']) : undefined),
    };
    expect(isConcurrencySafe(toolUse('x', 'mcp_write'), snapshot, new Set(['mcp_write']))).toBe(true);
    expect(isConcurrencySafe(toolUse('x', 'mcp_write'), snapshot, new Set())).toBe(true);
  });
});

describe('groupByConcurrencySafety', () => {
  it('连续安全项合组，不安全项各自成组，顺序保持', () => {
    const groups = groupByConcurrencySafety(
      ['r1', 'r2', 'w1', 'w2', 'r3', 'x1', 'r4', 'r5'],
      (item) => item.startsWith('r'),
    );
    expect(groups).toEqual([['r1', 'r2'], ['w1'], ['w2'], ['r3'], ['x1'], ['r4', 'r5']]);
  });

  it('空输入 ⇒ 无组', () => {
    expect(groupByConcurrencySafety([], () => true)).toEqual([]);
  });
});

// ─── Engine 级：executeTools 真正的执行顺序 ───────────────────────

type Trace = { started: string[]; finished: string[]; maxActive: number };

class SchedulingEngine extends AgentEngine {
  settleCalls: Array<{ id: string; result: string }> = [];
  readonly trace: Trace = { started: [], finished: [], maxActive: 0 };
  private active = 0;

  constructor() {
    super();
    this.id = 'agent-scheduling';
    this.mainAgentId = this.id;
    this.context = { flush: vi.fn(), getAllMessages: () => [] } as never;
    this.settler = {
      settleLive: vi.fn((settlement: { callId: string; result?: { text: string }; text?: string }) => {
        this.settleCalls.push({
          id: settlement.callId,
          result: settlement.result?.text ?? settlement.text ?? '',
        });
        return 'inserted';
      }),
    } as never;
  }

  buildSystemPrompt(): string { return ''; }
  getControlState(): AgentControlState { return {} as AgentControlState; }
  protected applyEvents(_events: AgentInputEvent[]): void {}
  protected appendConversationEntry(_entry: ConversationEntry): void {}
  protected override async runTurn(_signal: AbortSignal): Promise<TurnOutcome> { return {}; }

  /** 每个工具执行到 gates[id] 放行为止（无 gate 即立刻完成） */
  useGates(gates: Record<string, Promise<void>>): void {
    this.toolCoordinator = {
      run: vi.fn(async (raw: { modelName: string; callId: string }) => {
        this.trace.started.push(raw.callId);
        this.active++;
        this.trace.maxActive = Math.max(this.trace.maxActive, this.active);
        try {
          await gates[raw.callId];
        } finally {
          this.active--;
          this.trace.finished.push(raw.callId);
        }
        return new PendingSettlement(raw.callId, raw.modelName, { ok: true, text: `${raw.callId}-result` });
      }),
    } as never;
  }

  run(toolUses: ContentBlock[], options: ExecuteToolsOptions): Promise<unknown> {
    return this.executeTools(toolUses, CATALOG, options, new Set());
  }
}

const settleMicrotasks = async (rounds = 5): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

describe('executeTools 并行模式按 effects 分组', () => {
  it('同文件两个 edit 按发出顺序串行：第二个开始时第一个已结束', async () => {
    const engine = new SchedulingEngine();
    engine.approvalMode = 'auto';
    const first = Promise.withResolvers<void>();
    engine.useGates({ e1: first.promise });

    const running = engine.run([toolUse('e1', 'edit'), toolUse('e2', 'edit')], { mode: 'parallel' });
    await settleMicrotasks();
    expect(engine.trace.started).toEqual(['e1']);

    first.resolve();
    await running;
    expect(engine.trace.started).toEqual(['e1', 'e2']);
    expect(engine.trace.finished).toEqual(['e1', 'e2']);
    expect(engine.trace.maxActive).toBe(1);
    expect(engine.settleCalls.map((c) => c.id)).toEqual(['e1', 'e2']);
  });

  it('多个只读调用仍然并发', async () => {
    const engine = new SchedulingEngine();
    engine.approvalMode = 'auto';
    const gate = Promise.withResolvers<void>();
    engine.useGates({ r1: gate.promise, r2: gate.promise, s1: gate.promise });

    const running = engine.run(
      [toolUse('r1', 'read'), toolUse('r2', 'grep'), toolUse('s1', 'web_search')],
      { mode: 'parallel' },
    );
    await settleMicrotasks();
    expect(engine.trace.started).toEqual(['r1', 'r2', 's1']);
    expect(engine.trace.maxActive).toBe(3);

    gate.resolve();
    await running;
    expect(engine.settleCalls.map((c) => c.id)).toEqual(['r1', 'r2', 's1']);
  });

  it('混合批次：[read read] [edit] [shell] [read]，结果顺序与发出顺序一致', async () => {
    const engine = new SchedulingEngine();
    engine.approvalMode = 'auto';
    const reads = Promise.withResolvers<void>();
    const edit = Promise.withResolvers<void>();
    const shell = Promise.withResolvers<void>();
    engine.useGates({ r1: reads.promise, r2: reads.promise, e1: edit.promise, x1: shell.promise });

    const running = engine.run([
      toolUse('r1', 'read'),
      toolUse('r2', 'read'),
      toolUse('e1', 'edit'),
      toolUse('x1', 'shell'),
      toolUse('r3', 'read'),
    ], { mode: 'parallel' });

    await settleMicrotasks();
    expect(engine.trace.started).toEqual(['r1', 'r2']);
    reads.resolve();
    await settleMicrotasks();
    expect(engine.trace.started).toEqual(['r1', 'r2', 'e1']);
    edit.resolve();
    await settleMicrotasks();
    expect(engine.trace.started).toEqual(['r1', 'r2', 'e1', 'x1']);
    shell.resolve();
    await running;

    expect(engine.trace.started).toEqual(['r1', 'r2', 'e1', 'x1', 'r3']);
    expect(engine.trace.maxActive).toBe(2);
    expect(engine.settleCalls.map((c) => c.id)).toEqual(['r1', 'r2', 'e1', 'x1', 'r3']);
  });

  it('顺序模式不受影响：全部逐个执行', async () => {
    const engine = new SchedulingEngine();
    engine.approvalMode = 'auto';
    engine.useGates({});
    await engine.run([toolUse('r1', 'read'), toolUse('r2', 'read')], { mode: 'sequential' });
    expect(engine.trace.maxActive).toBe(1);
    expect(engine.trace.finished).toEqual(['r1', 'r2']);
  });

  it('confirm 审批模式下即使 mode=parallel 也逐个执行', async () => {
    const engine = new SchedulingEngine();
    engine.approvalMode = 'confirm';
    engine.useGates({});
    await engine.run([toolUse('r1', 'read'), toolUse('r2', 'read')], { mode: 'parallel' });
    expect(engine.trace.maxActive).toBe(1);
  });

  it('某个写类组执行期间中断：它的成功结果保留，后续组写 not_started', async () => {
    const engine = new SchedulingEngine();
    engine.approvalMode = 'auto';
    const controller = new AbortController();
    const edit = Promise.withResolvers<void>();
    engine.useGates({ e1: edit.promise });

    const running = engine.run(
      [toolUse('e1', 'edit'), toolUse('x1', 'shell'), toolUse('r1', 'read')],
      { mode: 'parallel', signal: controller.signal },
    );
    await settleMicrotasks();
    expect(engine.trace.started).toEqual(['e1']);

    controller.abort(new Error('user interrupted'));
    edit.resolve();
    await running;

    expect(engine.trace.started).toEqual(['e1']);
    const byId = new Map(engine.settleCalls.map((c) => [c.id, c.result]));
    expect(byId.get('e1')).toBe('e1-result');
    for (const id of ['x1', 'r1']) {
      expect(JSON.parse(byId.get(id)!)).toMatchObject({
        status: 'interrupted',
        reason: 'user_interrupted',
        execution: 'not_started',
      });
    }
  });
});
