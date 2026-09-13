import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-tool-test-'));
  return { app: { getPath: () => root, getAppPath: () => root } };
});

import { TaskTool } from '../task.tool.js';
import { parse, toApiSchema } from '../../params.js';
import type { ToolContext } from '../../types.js';
import { getStandaloneToolCatalog } from '../../index.js';
import { ToolCallContextFactory } from '../../../agent/tool-call/context-builder.js';
import { ToolCoordinator } from '../../coordinator.js';
import { taskBoardService } from '../../../agent-runs/task-board-service.js';
import type { TaskItem } from '../../../../shared/types/index.js';

function item(id: string, owner: string | null, overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id, subject: `Deliver ${id}`, description: `Implement and verify ${id}.`,
    status: 'pending', owner, dependsOn: [], ...overrides,
  };
}

function mainContext(mainAgentId: string, options: { active?: string[]; created?: string[]; mode?: 'normal' | 'plan' } = {}) {
  const setTaskBoard = vi.fn();
  return {
    agentType: 'main', agentSpec: 'director', agentId: mainAgentId, mainAgentId,
    runConfig: { name: 'Sample run', description: '', promptTemplate: '' },
    modes: { modeId: () => options.mode ?? 'normal', approvalMode: () => 'auto' },
    events: { allowedTargets: () => options.active ?? [] },
    subagents: { createdIds: () => options.created ?? options.active ?? [] },
    taskBoard: { set: setTaskBoard }, setTaskBoard,
  } as unknown as ToolContext & { setTaskBoard: ReturnType<typeof vi.fn> };
}

describe('Main task complete-list contract', () => {
  it('preserves the approved description and all field descriptions', () => {
    const tool = new TaskTool();
    expect(tool.def.scope).toBe('main');
    expect(tool.def.description).toBe(`维护当前执行范围的 Task Board。需要记录或协调任务范围、状态、依赖和责任人时调用；计划尚未获批时不能写入。

由你执行的任务使用自己的 agent_id。待委派且尚无 Worker 负责的任务使用 owner=null、status=pending。owner 只能使用系统已经提供的真实 Agent ID。

用户提出后续执行要求时，根据最新要求重新确定当前全部未完成任务，并将其完整提交到 items。`);
    const schema = toApiSchema(tool.def.schema);
    expect(Object.keys(schema.properties)).toEqual(['taskSummary', 'items']);
    expect(schema.required).toEqual(['items']);
    expect(schema.properties.taskSummary.description).toBe('首次建立看板或切换到独立顶层目标时提供的全局标题');
    expect(schema.properties.items.description).toBe('需要写入的任务数组；同一 ID 表示修改，新 ID 表示新增；提交范围和未提交任务的处理遵循工具说明');
    const fields = (schema.properties.items.items as { properties: Record<string, { description: string }>; required: string[] });
    expect(fields.required).toEqual(['id', 'subject', 'description', 'status', 'owner', 'dependsOn']);
    expect(Object.fromEntries(Object.entries(fields.properties).map(([key, field]) => [key, field.description]))).toEqual({
      id: '看板内稳定且唯一的逻辑任务 ID', subject: '短而具体的任务名称',
      description: '单项目标、预期产出、完成标准与必要交接事实',
      status: '工作义务的当前进度；同一 owner 同时最多一个任务为 in_progress',
      owner: '当前责任 Agent ID；自身使用自己的 agent_id，null 表示未分配',
      dependsOn: '前置任务的稳定 ID；无依赖时提交空数组，删除被依赖项前先更新引用',
    });
  });

  it('exposes and resolves task only in the main catalog scope', () => {
    const catalog = getStandaloneToolCatalog();
    const main = catalog.snapshot({ scope: 'main', agentType: 'main', customTools: ['task'], exposedSkillFunctions: [], excluded: new Set(), domains: new Set(['local']) });
    const worker = catalog.snapshot({ scope: 'subagent', agentType: 'worker', customTools: ['task', 'send_event'], exposedSkillFunctions: [], excluded: new Set(), domains: new Set(['local']) });
    expect(main.definitions().map((tool) => tool.name)).toEqual(['task']);
    expect(worker.definitions().map((tool) => tool.name)).toEqual(['send_event']);
    expect(worker.resolve('task')).toBeUndefined();
    expect(catalog.configurationDefinitions().map((tool) => tool.name)).not.toContain('task_read');
  });

  it('retains parameter normalization at the coordinator boundary', () => {
    expect(parse(new TaskTool().def.schema, { action: 'read', items: [] }))
      .toEqual({ ok: true, value: { items: [] } });
  });

  it('directly creates, updates and removes items while publishing the full UI state', async () => {
    const context = mainContext('main-direct');
    const tool = new TaskTool();
    const first = await tool.execute({ taskSummary: 'Sample board', items: [item('old', null)] }, context);
    expect(first.ok).toBe(true);
    const items = [item('done', 'main-direct', { status: 'completed' }), item('next', null, { dependsOn: ['done'] })];
    const result = await tool.execute({ items }, context);
    expect(result).toMatchObject({ ok: true, data: { taskSummary: 'Sample board', items, progress: { total: 2, completed: 1, inProgress: 0, pending: 1 } } });
    expect(result.text).toBe('Task Board 已同步：1/2 completed，0 in_progress，1 pending');
    expect(context.setTaskBoard).toHaveBeenLastCalledWith({ taskSummary: 'Sample board', items });
  });

  it('uses the actual per-call ports for owner validation and the unchanged conditional Worker notice', async () => {
    const context = mainContext('main-notice', { active: ['worker-a'] });
    const factory = new ToolCallContextFactory({ signal: () => new AbortController().signal, activation: {
      ...context, resourceIds: {}, currentModel: () => 'provider::model',
      workspace: { dir: '/workspace/sample', tempDir: '/tmp/sample' }, post: () => true,
    } });
    const coordinator = new ToolCoordinator({ contexts: factory });
    const snapshot = getStandaloneToolCatalog().snapshot({ scope: 'main', agentType: 'main', customTools: ['task'], exposedSkillFunctions: [], excluded: new Set(), domains: new Set(['local']) });
    await coordinator.run({ modelName: 'task', callId: 'create-board', rawParams: {
      taskSummary: 'Sample board', items: [item('worker-task', 'worker-a', { status: 'in_progress' })],
    } }, snapshot);
    const result = await coordinator.run({ modelName: 'task', callId: 'update-board', rawParams: {
      items: [item('worker-task', 'worker-a', { status: 'completed' })],
    } }, snapshot);
    expect(result).toMatchObject({ result: { ok: true, text: 'Task Board 已同步：1/1 completed，0 in_progress，0 pending\n\n若本次变更包含 Worker 继续执行所需的新信息，且尚未告知对应 Worker，则向其发送更新。\n\n受影响 Worker：\n- worker-a（任务：worker-task）' } });
  });

  it('accepts the first owner record after a Worker has stopped', async () => {
    const result = await new TaskTool().execute({
      taskSummary: 'Sample delivery', items: [item('delivered', 'worker-ended', { status: 'completed' })],
    }, mainContext('main-late-owner', { created: ['worker-ended'], active: [] }));
    expect(result).toMatchObject({ ok: true, data: { items: [item('delivered', 'worker-ended', { status: 'completed' })] } });
  });

  it('returns the complete current board when a submitted new owner is unknown', async () => {
    const context = mainContext('main-owner');
    const tool = new TaskTool();
    const items = [item('first', null), item('second', 'main-owner')];
    await tool.execute({ taskSummary: 'Sample board', items }, context);
    const result = await tool.execute({ items: [item('new', 'worker-unknown')] }, context);
    expect(result).toMatchObject({ ok: false, data: { code: 'invalid', taskBoard: { items } } });
    expect(result.text).toContain('owner 不是当前 Main 或正在运行的 Worker');
    expect(context.setTaskBoard).toHaveBeenLastCalledWith({ taskSummary: 'Sample board', items });
  });

  it('keeps plan approval as a code-level write boundary', async () => {
    const result = await new TaskTool().execute({ taskSummary: 'Sample board', items: [item('a', null)] }, mainContext('main-plan', { mode: 'plan' }));
    expect(result).toMatchObject({ ok: false, text: '计划尚未获批——先用 plan(create) 提交计划正文审批；获批后再建立 Task Board' });
    expect(await taskBoardService.readTaskBoard('main-plan')).toBeNull();
  });

  it('retains the unassigned in-progress constraint', async () => {
    const result = await new TaskTool().execute({ taskSummary: 'Sample board', items: [item('a', null, { status: 'in_progress' })] }, mainContext('main-unassigned'));
    expect(result.ok).toBe(false);
    expect(result.text).toContain('owner=null、status=pending');
  });
});
