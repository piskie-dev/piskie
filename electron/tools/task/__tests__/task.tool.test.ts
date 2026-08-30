import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-tool-test-'));
  return { app: { getPath: () => root, getAppPath: () => root } };
});

import { TaskReadTool } from '../task-read.tool.js';
import { TaskTool } from '../task.tool.js';
import { parse, toApiSchema } from '../../params.js';
import { toToolResult, type ToolContext } from '../../types.js';
import type { TaskItem } from '../../../../shared/types/index.js';

function item(id: string, owner: string | null, overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id,
    subject: `完成 ${id}`,
    description: `实现 ${id} 并验证。`,
    status: 'pending',
    owner,
    dependsOn: [],
    ...overrides,
  };
}

function mainContext(mainAgentId: string, overrides: Record<string, unknown> = {}) {
  const setTaskBoard = vi.fn();
  const getMode = (overrides.getMode as (() => 'normal' | 'plan') | undefined) ?? (() => 'normal');
  const activeWorkerIds = (overrides.activeWorkerIds as readonly string[] | undefined) ?? [];
  return {
    agentType: 'main',
    agentSpec: 'director',
    agentId: mainAgentId,
    mainAgentId,
    runConfig: { name: 'Run', description: '', promptTemplate: '' },
    modes: { modeId: getMode, approvalMode: () => 'auto' },
    events: { allowedTargets: () => activeWorkerIds },
    taskBoard: { set: setTaskBoard },
    contextManager: {} as never,
    setTaskBoard,
  } as unknown as ToolContext & { setTaskBoard: ReturnType<typeof vi.fn> };
}

function workerContext(mainAgentId: string, workerId: string, snapshotOwner: string | null = null) {
  const setTaskBoard = vi.fn();
  return {
    agentType: 'worker',
    agentSpec: 'local-worker',
    agentId: workerId,
    mainAgentId,
    runConfig: { name: 'Run', description: '', promptTemplate: '' },
    modes: { modeId: () => 'normal', approvalMode: () => 'auto' },
    subagentConfig: {
      mode: 'local',
      subject: '后端工作包',
      taskIds: ['task-a'],
      prompt: '完成 task-a。',
      skills: [],
    },
    assignmentSnapshot: {
      taskSummary: '测试看板',
      items: [{
        id: 'task-a', subject: '完成 task-a', status: 'pending', owner: snapshotOwner,
        dependsOn: [], assignedHere: true,
      }],
    },
    taskBoard: { set: setTaskBoard },
    contextManager: {} as never,
    setTaskBoard,
  } as unknown as ToolContext & { setTaskBoard: ReturnType<typeof vi.fn> };
}

describe('TaskTool complete-list protocol', () => {
  it('Main 看见 task_read 和完整 task，Worker 只看见 owner 范围 task', () => {
    const tool = new TaskTool();
    const taskReadTool = new TaskReadTool();
    const mainDescription = typeof tool.def.description === 'function'
      ? tool.def.description('main')
      : tool.def.description;
    const workerDescription = typeof tool.def.description === 'function'
      ? tool.def.description('worker')
      : tool.def.description;
    const schema = toApiSchema(tool.def.schema);
    expect(tool.def.scope).toBe('shared');
    expect(taskReadTool.def.scope).toBe('main');
    expect(taskReadTool.def.description).toBe(
      '读取当前执行范围的 Task Board。在修改已有看板前调用。',
    );
    expect(schema).not.toHaveProperty('additionalProperties');
    expect(Object.keys(schema.properties)).toEqual(['taskSummary', 'items']);
    expect(schema.required).toEqual(['items']);
    expect(JSON.stringify(schema)).not.toMatch(/action|itemId|removeItemIds|generation|baseRevision/);
    expect(mainDescription).toContain('维护当前执行范围的 Task Board');
    expect(mainDescription).toContain('修改已有看板前先调用 task_read 获取最新任务状态');
    expect(mainDescription).toContain(
      '用户提出后续执行要求时，根据最新要求和 task_read 结果重新确定当前全部未完成任务，并将其完整提交到 items',
    );
    expect(mainDescription).not.toContain('获取最新完整列表');
    expect(mainDescription).toContain('需要记录或协调任务范围、状态、依赖和责任人时调用');
    expect(mainDescription).not.toContain('单一步骤和纯问答不使用');
    expect(mainDescription).not.toContain('改变执行范围');
    expect(mainDescription).not.toContain('现有任务未提交表示删除');
    expect(mainDescription).toContain('task_read');
    expect(mainDescription).toContain('owner=null、status=pending');
    expect(mainDescription).toContain('之后由 Worker 自行认领');
    expect(mainDescription).toContain('真实 Agent ID');
    expect(mainDescription).not.toContain('看板在读取后发生变化时');
    expect(mainDescription).not.toContain('只能原样保留');
    expect(workerDescription).toContain('变化时直接提交');
    expect(workerDescription).not.toContain('task_read');
    expect(workerDescription).toContain('认领时把 owner 设为你自己的 agent_id');
    expect(workerDescription).toContain('assigned_here=true 并被你认领的任务');
    expect(workerDescription).toContain('无权修改或使用其他 task');
    expect(workerDescription).toContain('当前属于你的任务未提交表示删除；其他任务由系统保留');
    expect(workerDescription).toContain('新增任务必须使用看板中尚未出现的 ID');
    expect(JSON.stringify(schema)).not.toContain('现有 ID 未提交表示删除');
    expect(JSON.stringify(schema)).not.toContain('<session_config>');
    expect(mainDescription).not.toContain('send_event');
    expect(workerDescription).not.toContain('send_event');
  });

  it('zod 在 Coordinator 边界移除旧 action 和任意额外字段', () => {
    const parsed = parse(new TaskTool().def.schema, {
      action: 'read',
      items: [],
    });
    expect(parsed).toEqual({ ok: true, value: { items: [] } });
  });

  it('Main 首次完整同步并更新 UI 权威投影', async () => {
    const tool = new TaskTool();
    const context = mainContext('main-main');
    const result = await tool.execute({
      taskSummary: '测试看板',
      items: [item('task-a', null), item('task-main', 'main-main')],
    }, context);

    expect(result.ok).toBe(true);
    expect(context.setTaskBoard).toHaveBeenCalledWith(expect.objectContaining({
      taskSummary: '测试看板',
      items: expect.arrayContaining([expect.objectContaining({ id: 'task-a' })]),
    }));
  });

  it('Worker 变更后 Main 必须通过 task_read 获取完整事实才能全局替换', async () => {
    const taskTool = new TaskTool();
    await taskTool.execute({
      taskSummary: '旧目标',
      items: [item('task-a', 'worker-a'), item('old-main', 'main-read-before-replace')],
    }, mainContext('main-read-before-replace', { activeWorkerIds: ['worker-a'] }));
    await taskTool.execute({
      items: [item('task-a', 'worker-a', { status: 'completed', subject: 'Worker 已完成' })],
    }, workerContext('main-read-before-replace', 'worker-a', 'worker-a'));

    const staleContext = mainContext('main-read-before-replace');
    const stale = await taskTool.execute({
      taskSummary: '新目标',
      items: [item('new-task', 'main-read-before-replace')],
    }, staleContext);
    expect(stale.ok).toBe(false);
    expect(stale.text).toContain('请重新调用 task_read 后重试');
    expect(stale.text).not.toContain('完整列表');
    expect(stale.data).toEqual({ code: 'read_required' });
    expect(staleContext.setTaskBoard).toHaveBeenCalledWith(expect.objectContaining({
      items: expect.arrayContaining([expect.objectContaining({ subject: 'Worker 已完成' })]),
    }));

    const readContext = mainContext('main-read-before-replace');
    const read = await new TaskReadTool().execute({}, readContext);
    expect(read.ok).toBe(true);
    expect((read.data as { items: TaskItem[] }).items.map((entry) => entry.id)).toEqual([
      'task-a', 'old-main',
    ]);

    const replaced = await taskTool.execute({
      taskSummary: '新目标',
      items: [item('new-task', 'main-read-before-replace')],
    }, mainContext('main-read-before-replace'));
    expect(replaced.ok).toBe(true);
    expect((replaced.data as { items: TaskItem[] }).items.map((entry) => entry.id)).toEqual(['new-task']);
  });

  it('Main 修改 Worker 未完成任务时返回条件式通知目标', async () => {
    const tool = new TaskTool();
    await tool.execute({
      taskSummary: '协调看板',
      items: [item('worker-task', 'worker-a', { status: 'in_progress' })],
    }, mainContext('main-worker-notice', { activeWorkerIds: ['worker-a'] }));

    const result = await tool.execute({
      items: [item('worker-task', 'worker-a', { status: 'completed', subject: 'Main 已调整' })],
    }, mainContext('main-worker-notice', { activeWorkerIds: ['worker-a'] }));
    expect(result.ok).toBe(true);
    expect(result.text).toContain('若本次变更包含 Worker 继续执行所需的新信息，且尚未告知对应 Worker');
    expect(result.text).toContain('- worker-a（任务：worker-task）');
    expect(result.text).not.toContain('同步最新要求，或关闭 Worker');
    expect((result.data as { affectedWorkers: unknown }).affectedWorkers).toEqual([
      { workerId: 'worker-a', taskIds: ['worker-task'] },
    ]);
  });

  it('task_read 是无参数只读工具，额外键在边界剥离且 plan 模式也可读取', async () => {
    const tool = new TaskReadTool();
    expect(parse(tool.def.schema, { unexpected: true })).toEqual({ ok: true, value: {} });

    const missing = await tool.execute({}, mainContext('main-task-read', { getMode: () => 'plan' }));
    expect(missing.ok).toBe(true);
    expect(missing.data).toEqual({ taskBoard: null });
  });

  it('task_read 向模型完整返回未完成任务并压缩已完成任务', async () => {
    const mainAgentId = 'main-model-visible-read';
    const unfinished = item('unfinished-task', 'worker-active', {
      subject: '处理未完成事项',
      description: '保留完整范围、产出和验收信息。',
      status: 'in_progress',
      dependsOn: [],
    });
    const completed = item('completed-task', 'worker-done', {
      subject: '处理已完成事项',
      description: '这段已完成详情不应进入模型可见结果。',
      status: 'completed',
      dependsOn: [],
    });
    await new TaskTool().execute({
      taskSummary: '模型可见读取测试',
      items: [unfinished, completed],
    }, mainContext(mainAgentId, { activeWorkerIds: ['worker-active', 'worker-done'] }));

    const output = await new TaskReadTool().execute({}, mainContext(mainAgentId));
    const modelResult = toToolResult(output);

    expect(modelResult.text).not.toContain('Task Board 已读取：');
    expect(modelResult.text).toContain('taskSummary："模型可见读取测试"');
    expect(modelResult.text).toContain(`当前未完成任务：${JSON.stringify([unfinished])}`);
    expect(modelResult.text).toContain(
      '已完成任务：[{"id":"completed-task","subject":"处理已完成事项"}]',
    );
    expect(modelResult.text).not.toContain('这段已完成详情不应进入模型可见结果');
    expect(modelResult.text).not.toContain('"owner":"worker-done"');
    expect(modelResult.text).not.toContain('"status":"completed"');
    expect((output.data as { items: TaskItem[] }).items).toEqual([unfinished, completed]);
  });

  it('Worker 根据创建快照认领任务，多传的 taskSummary 被忽略且结果只返回相关任务', async () => {
    const tool = new TaskTool();
    await tool.execute({
      taskSummary: '测试看板',
      items: [item('task-a', null), item('other', 'worker-b')],
    }, mainContext('main-worker', { activeWorkerIds: ['worker-b'] }));

    const result = await tool.execute({
      taskSummary: 'Worker 不应覆盖的标题',
      items: [item('task-a', 'worker-a', { status: 'in_progress' })],
    }, workerContext('main-worker', 'worker-a'));
    expect(result.ok).toBe(true);
    expect((result.data as { taskSummary: string }).taskSummary).toBe('测试看板');
    expect((result.data as { items: TaskItem[] }).items.map((entry) => entry.id)).toEqual(['task-a']);
  });

  it('owner 冲突返回最新看板事实', async () => {
    const tool = new TaskTool();
    await tool.execute({
      taskSummary: '冲突看板',
      items: [item('task-a', 'worker-a'), item('unrelated', 'worker-c')],
    }, mainContext('main-conflict', { activeWorkerIds: ['worker-a', 'worker-c'] }));

    const conflictContext = workerContext('main-conflict', 'worker-b', null);
    const conflict = await tool.execute({
      items: [item('task-a', 'worker-b')],
    }, conflictContext);
    expect(conflict.ok).toBe(false);
    expect(conflict.text).toContain('owner 冲突');
    expect((conflict.data as { taskBoard: { items: TaskItem[] } }).taskBoard.items[0]?.owner).toBe('worker-a');
    expect((conflict.data as { taskBoard: { items: TaskItem[] } }).taskBoard.items).toHaveLength(1);
    expect(conflictContext.setTaskBoard).toHaveBeenCalledWith(expect.objectContaining({
      items: [
        expect.objectContaining({ id: 'task-a', owner: 'worker-a' }),
        expect.objectContaining({ id: 'unrelated', owner: 'worker-c' }),
      ],
    }));
  });

  it('Worker 不能认领未指派给自己的 unassigned 任务', async () => {
    const tool = new TaskTool();
    await tool.execute({
      taskSummary: '未分配看板',
      items: [item('task-a', null), item('unassigned-task', null)],
    }, mainContext('main-unassigned-conflict'));

    const conflict = await tool.execute({
      items: [item('unassigned-task', 'worker-a')],
    }, workerContext('main-unassigned-conflict', 'worker-a'));

    expect(conflict.ok).toBe(false);
    expect(conflict.text).toContain('当前未分配，但未指派给 worker-a');
    expect(conflict.text).toContain('无权认领、修改或使用该 task');
    expect((conflict.data as { taskBoard: { items: TaskItem[] } }).taskBoard.items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'task-a', owner: null }),
        expect.objectContaining({ id: 'unassigned-task', owner: null }),
      ]));
  });

  it('Worker 返回本次新建并转交的任务最新事实', async () => {
    const tool = new TaskTool();
    await tool.execute({
      taskSummary: '转交看板',
      items: [item('task-a', null)],
    }, mainContext('main-transfer-result'));
    const context = workerContext('main-transfer-result', 'worker-a');

    await tool.execute({
      items: [item('task-a', 'worker-a', { status: 'in_progress' })],
    }, context);
    const result = await tool.execute({
      items: [
        item('task-a', 'main-transfer-result', { status: 'pending' }),
        item('worker-a-follow-up', 'main-transfer-result', { dependsOn: ['task-a'] }),
      ],
    }, context);

    expect(result.ok).toBe(true);
    expect((result.data as { items: TaskItem[] }).items.map((entry) => entry.id)).toEqual([
      'task-a', 'worker-a-follow-up',
    ]);
  });

  it('plan 模式代码级拒绝写入', async () => {
    const result = await new TaskTool().execute({
      taskSummary: '不应写入', items: [item('a', null)],
    }, mainContext('main-plan', { getMode: () => 'plan' }));
    expect(result.ok).toBe(false);
    expect(result.text).toContain('计划尚未获批');
  });

  it('Main 拒绝虚构 owner 和未分配的 in_progress，但接受真实活跃 Worker', async () => {
    const tool = new TaskTool();
    const fake = await tool.execute({
      taskSummary: '虚构 owner',
      items: [item('fake', 'pending-controls-worker')],
    }, mainContext('main-fake-owner'));
    expect(fake.ok).toBe(false);
    expect(fake.text).toContain('owner 不是当前 Main 或正在运行的 Worker');

    const unassigned = await tool.execute({
      taskSummary: '未分配执行中',
      items: [item('invalid-progress', null, { status: 'in_progress' })],
    }, mainContext('main-invalid-progress'));
    expect(unassigned.ok).toBe(false);
    expect(unassigned.text).toContain('owner=null、status=pending');

    const active = await tool.execute({
      taskSummary: '真实 Worker',
      items: [item('assigned', 'worker-real')],
    }, mainContext('main-real-owner', { activeWorkerIds: ['worker-real'] }));
    expect(active.ok).toBe(true);
  });
});
