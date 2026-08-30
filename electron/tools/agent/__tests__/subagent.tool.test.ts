import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvironmentMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
}));
vi.mock('../../../services/browser-environment-runtime.js', () => ({
  browserEnvironmentRuntime: {
    getEnvironment: getEnvironmentMock,
  },
}));

import { SubagentTool } from '../subagent.tool.js';
import { TaskBoardError, taskBoardService } from '../../../agent-runs/task-board-service.js';
import { parse, toApiSchema } from '../../params.js';
import { ToolCatalog } from '../../catalog.js';

const snapshot = {
  taskSummary: '共享看板',
  items: [
    {
      id: 'task-a', subject: '完成 A', status: 'pending' as const, owner: null,
      dependsOn: [], assignedHere: true,
    },
    {
      id: 'task-b', subject: '完成 B', status: 'in_progress' as const, owner: 'worker-b',
      dependsOn: ['task-a'], assignedHere: false,
    },
  ],
};

function createContext(overrides: Record<string, unknown> = {}) {
  const createSubagent = (overrides.createSubagent as ReturnType<typeof vi.fn> | undefined)
    ?? vi.fn().mockResolvedValue('local-main-agent-1');
  const traceFilePath = (overrides.traceFilePath as ReturnType<typeof vi.fn> | undefined)
    ?? vi.fn();
  const resolveType = (overrides.resolveType as ReturnType<typeof vi.fn> | undefined)
    ?? vi.fn((type: string) => ({
      error: type === 'director'
        ? "AgentSpec 'director' is not a Worker and cannot be created as a subagent"
        : `未知的子流程类型: ${type}`,
    }));
  const runConfig = (overrides.runConfig as Record<string, unknown> | undefined) ?? {
    name: 'Run',
    description: '',
    promptTemplate: '',
  };
  return {
    agentType: 'main',
    agentSpec: 'director',
    agentId: 'main-agent',
    mainAgentId: 'main-agent',
    runConfig,
    subagents: {
      resolveType,
      create: createSubagent,
      destroy: vi.fn(),
      traceFilePath,
    },
    contextManager: {} as never,
  } as never;
}

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    action: 'create',
    type: 'local',
    subject: ' 后端闭环 ',
    taskIds: ['task-a'],
    prompt: '完成 task-a，验证产出并报回结果。',
    ...overrides,
  };
}

describe('SubagentTool Assignment create', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(taskBoardService, 'createCompactSnapshot').mockResolvedValue(snapshot);
  });

  it('schema 只公开 subject/taskIds/prompt 等新协议字段', () => {
    const tool = new SubagentTool();
    const schema = toApiSchema(tool.def.schema);
    expect(schema).not.toHaveProperty('additionalProperties');
    expect(schema.properties).not.toHaveProperty('taskDescription');
    expect(schema.properties).toHaveProperty('subject');
    expect(schema.properties).toHaveProperty('taskIds');
    expect(schema.properties).toHaveProperty('prompt');
    expect(schema.properties).not.toHaveProperty('contextFiles');
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.type.description).toContain('create 必填');
    expect(tool.def.description).toContain('刚走进房间的聪明同事');
    expect(tool.def.description).toContain('能力完整，可以自主判断');
    expect(tool.def.description).toContain('可观察结果');
    expect(tool.def.description).not.toContain('不要委派理解');
    expect(schema.properties.skills.description).toContain('Skill 名称列表');
    expect(schema.properties.skills.description).not.toContain('skillId');
    expect(tool.def.description).not.toContain('contextFiles');
    expect(tool.def.description).not.toContain('assigned_here');
    expect(tool.def.description).not.toContain('自动回收');
  });

  it('模型 Schema 精确列出当前 Director 的通用和专属 Worker type', () => {
    const catalog = new ToolCatalog();
    catalog.register(new SubagentTool(), 'builtin');
    const definition = catalog.snapshot({
      scope: 'main',
      agentType: 'main',
      customTools: ['subagent'],
      exposedSkillFunctions: [],
      excluded: new Set(),
      domains: new Set(['local']),
      subagentTypes: [
        { name: 'site-scout', mode: 'browser', description: '侦察网站能力与风险' },
        { name: 'browser-skill-builder', mode: 'browser', description: '编写并测试 Skill' },
      ],
      subagentResources: {
        browserEnvironmentIds: ['environment-a', 'environment-b'],
      },
    }).definitions().find((candidate) => candidate.name === 'subagent');
    const type = definition?.input_schema.properties.type as {
      enum?: string[];
      description?: string;
    };

    expect(type.enum).toEqual([
      'browser',
      'local',
      'site-scout',
      'browser-skill-builder',
    ]);
    expect(type.description).toContain('site-scout：侦察网站能力与风险');
    expect(type.description).toContain('不得自行改名');
    expect(JSON.stringify(definition?.input_schema.oneOf)).not.toContain('description');
    expect(JSON.stringify(definition?.input_schema).match(/完整、自包含的任务简报/g)).toHaveLength(1);
    expect(definition?.input_schema.properties.browserEnvironmentId).toMatchObject({
      enum: ['environment-a', 'environment-b'],
    });
    expect(definition?.input_schema.oneOf).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({ type: { enum: ['local'] } }),
        required: ['action', 'type', 'subject', 'taskIds', 'prompt'],
        additionalProperties: false,
      }),
      expect.objectContaining({
        properties: expect.objectContaining({
          type: { enum: ['browser', 'site-scout', 'browser-skill-builder'] },
          browserEnvironmentId: {},
        }),
        required: ['action', 'type', 'subject', 'taskIds', 'prompt', 'browserEnvironmentId'],
        additionalProperties: false,
      }),
      {
        properties: { action: { const: 'stop' }, subagentId: {} },
        required: ['action', 'subagentId'],
        additionalProperties: false,
      },
    ]);
  });

  it('统一参数入口将可选字符串占位值按未提供处理', () => {
    const tool = new SubagentTool();
    const parsed = parse(tool.def.schema, assignment({
      skills: [],
      browserEnvironmentId: ' null ',
      subagentId: '',
    }));

    expect(parsed).toEqual({
      ok: true,
      value: expect.objectContaining({
        action: 'create',
        type: 'local',
        subject: '后端闭环',
        prompt: '完成 task-a，验证产出并报回结果。',
      }),
    });
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    expect(parsed.value).not.toHaveProperty('browserEnvironmentId');
    expect(parsed.value).not.toHaveProperty('subagentId');
  });

  it('未绑定环境池时模型 Schema 不展示 browserEnvironmentId', () => {
    const catalog = new ToolCatalog();
    catalog.register(new SubagentTool(), 'builtin');
    const definition = catalog.snapshot({
      scope: 'main',
      agentType: 'main',
      customTools: ['subagent'],
      exposedSkillFunctions: [],
      excluded: new Set(),
      domains: new Set(['local']),
      subagentTypes: [],
      subagentResources: { browserEnvironmentIds: [] },
    }).definitions().find((candidate) => candidate.name === 'subagent');

    expect(definition?.input_schema.properties).not.toHaveProperty('browserEnvironmentId');
    expect(JSON.stringify(definition?.input_schema.oneOf)).not.toContain('browserEnvironmentId');
  });

  it('create 的必填字符串为空时仍返回缺少字段，而不是 minLength 错误', () => {
    const parsed = parse(new SubagentTool().def.schema, assignment({ type: '   ' }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.join('\n')).toContain('action=create 时需要提供 type');
      expect(parsed.errors.join('\n')).not.toContain('Too small');
    }
  });

  it('create 缺少 type 时按 ToolDefinition 的条件必填契约拒绝', async () => {
    const parsed = parse(new SubagentTool().def.schema, assignment({ type: undefined }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join('\n')).toContain('需要提供 type');
  });

  it('拒绝未知 type，同时保留 Runtime 机械校验', async () => {
    const result = await new SubagentTool().execute(
      assignment({ type: 'no-such-type' }),
      createContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('未知的子流程类型');
  });

  it('工具解析层拒绝非 Worker Spec', async () => {
    const result = await new SubagentTool().execute(
      assignment({ type: 'director' }),
      createContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('not a Worker');
  });

  it('专属 Worker 由当前 Director 的运行时权限解析，不改变普通 Assignment 结构', async () => {
    const createSubagent = vi.fn().mockResolvedValue('browser-skill-builder-main-agent-1');
    const resolveType = vi.fn().mockReturnValue({
      mode: 'browser',
      agentSpec: 'browser-skill-builder',
    });
    const result = await new SubagentTool().execute(
      assignment({ type: 'browser-skill-builder' }),
      createContext({ createSubagent, resolveType }),
    );

    expect(result.ok).toBe(true);
    expect(resolveType).toHaveBeenCalledWith('browser-skill-builder');
    expect(createSubagent).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'browser',
      agentSpec: 'browser-skill-builder',
      prompt: '完成 task-a，验证产出并报回结果。',
    }), snapshot);
    expect(createSubagent.mock.calls[0][0]).not.toHaveProperty('browserSkillAssignment');
  });

  it('被当前 Director 禁止的专属 Worker 在读取 Task Board 前拒绝', async () => {
    const createSubagent = vi.fn();
    const resolveType = vi.fn().mockReturnValue({
      error: "AgentSpec 'director' cannot create protected Worker 'browser-skill-builder'",
    });
    const result = await new SubagentTool().execute(
      assignment({ type: 'browser-skill-builder' }),
      createContext({ createSubagent, resolveType }),
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain('cannot create protected Worker');
    expect(taskBoardService.createCompactSnapshot).not.toHaveBeenCalled();
    expect(createSubagent).not.toHaveBeenCalled();
  });

  it('trim subject 后保存，并把 config 与一次性 snapshot 交给 Runtime', async () => {
    const createSubagent = vi.fn().mockResolvedValue('local-main-agent-1');
    const tool = new SubagentTool();
    const parsed = parse(tool.def.schema, assignment({ skills: ['skill-a', 'skill-b'] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const result = await tool.execute(parsed.value, createContext({ createSubagent }));

    expect(result.ok).toBe(true);
    expect(taskBoardService.createCompactSnapshot).toHaveBeenCalledTimes(1);
    expect(taskBoardService.createCompactSnapshot).toHaveBeenCalledWith('main-agent', ['task-a']);
    expect(createSubagent).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'local',
      subject: '后端闭环',
      taskIds: ['task-a'],
      prompt: '完成 task-a，验证产出并报回结果。',
      skills: ['skill-a', 'skill-b'],
    }), snapshot);
    expect(createSubagent.mock.calls[0][0]).not.toHaveProperty('ataEnvelopes');
    expect(result.text).toContain('Worker 已按要求创建: 后端闭环');
    expect(result.text).toContain('subagentId: local-main-agent-1');
    expect(result.text).not.toContain('type: local');
    expect(result.data).toEqual(expect.objectContaining({ type: 'local' }));
    expect(result.data).not.toHaveProperty('mode');
  });

  it('只建议在用户查询进度或怀疑卡住时读取 trace', async () => {
    const traceFilePath = vi.fn().mockReturnValue('/tmp/local-main-agent-1.trace.md');
    const result = await new SubagentTool().execute(
      assignment(),
      createContext({ traceFilePath }),
    );

    expect(result.ok).toBe(true);
    expect(result.text).toContain('仅在用户主动查询进度或怀疑 Worker 卡住时用 read 读取');
    expect(result.text).toContain('正常执行会通过事件通知，无需轮询');
    expect(result.text).not.toContain('readFile');
    expect(result.text).not.toContain('可随时查看子流程进度');
  });

  it('拒绝空/过长 subject、空/重复 taskIds 和空 prompt', async () => {
    const tool = new SubagentTool();
    for (const params of [
      assignment({ subject: '   ' }),
      assignment({ subject: 'x'.repeat(41) }),
      assignment({ taskIds: [] }),
      assignment({ taskIds: ['task-a', 'task-a'] }),
      assignment({ prompt: '   ' }),
    ]) {
      expect(parse(tool.def.schema, params).ok).toBe(false);
    }
  });

  it('任一 taskId 缺失时返回完整缺失列表且不创建 Worker', async () => {
    vi.mocked(taskBoardService.createCompactSnapshot).mockRejectedValueOnce(
      new TaskBoardError('Task Board 中不存在以下 taskIds: missing-a, missing-b', 'not_found'),
    );
    const createSubagent = vi.fn();
    const result = await new SubagentTool().execute(
      assignment({ taskIds: ['missing-a', 'missing-b'] }),
      createContext({ createSubagent }),
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain('missing-a, missing-b');
    expect(createSubagent).not.toHaveBeenCalled();
  });

  it('不根据 status/owner/dependsOn 或多个 skills 做业务适合性拒绝', async () => {
    const createSubagent = vi.fn().mockResolvedValue('browser-main-agent-1');
    const result = await new SubagentTool().execute(
      assignment({ type: 'browser', taskIds: ['task-a', 'task-b'], skills: ['site-a', 'site-b'] }),
      createContext({ createSubagent }),
    );
    expect(result.ok).toBe(true);
    expect(createSubagent).toHaveBeenCalledOnce();
  });
});

describe('SubagentTool browser environment validation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getEnvironmentMock.mockReset();
    vi.spyOn(taskBoardService, 'createCompactSnapshot').mockResolvedValue(snapshot);
  });

  it('未绑定环境池时保持普通临时浏览器路径', async () => {
    const createSubagent = vi.fn().mockResolvedValue('browser-main-agent-1');
    const result = await new SubagentTool().execute(
      assignment({ type: 'browser' }),
      createContext({ createSubagent }),
    );

    expect(result.ok).toBe(true);
    expect(createSubagent).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'browser',
    }), snapshot);
    expect(createSubagent.mock.calls[0][0].browserEnvironmentId).toBeUndefined();
  });

  it('绑定环境池时 browser Worker 必须使用池内 browserEnvironmentId', async () => {
    const createSubagent = vi.fn();
    const context = createContext({
      createSubagent,
      runConfig: {
        name: 'Run',
        description: '',
        promptTemplate: '',
        bindings: { type: 'standard', boundEnvironmentIds: ['environment-a', 'environment-b'] },
      },
    });

    const missing = await new SubagentTool().execute(assignment({ type: 'browser' }), context);
    const outside = await new SubagentTool().execute(
      assignment({ type: 'browser', browserEnvironmentId: 'environment-c' }),
      context,
    );

    expect(missing.ok).toBe(false);
    expect(missing.text).toContain('必须提供 browserEnvironmentId');
    expect(outside.ok).toBe(false);
    expect(outside.text).toContain('不在绑定的浏览器环境池中');
    expect(createSubagent).not.toHaveBeenCalled();
  });

  it('池内合法 browserEnvironmentId 透传给 Runtime 并回显在结果 data 中', async () => {
    const createSubagent = vi.fn().mockResolvedValue('browser-main-agent-1');
    getEnvironmentMock.mockReturnValue({ id: 'environment-a', name: 'A' });
    const result = await new SubagentTool().execute(
      assignment({ type: 'browser', browserEnvironmentId: 'environment-a' }),
      createContext({
        createSubagent,
        runConfig: {
          name: 'Run',
          description: '',
          promptTemplate: '',
          bindings: { type: 'standard', boundEnvironmentIds: ['environment-a', 'environment-b'] },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(createSubagent).toHaveBeenCalledWith(expect.objectContaining({
      browserEnvironmentId: 'environment-a',
    }), snapshot);
    expect(result.data).toEqual(expect.objectContaining({ browserEnvironmentId: 'environment-a' }));
  });

  it('未绑定环境池时拒绝直接指定 browserEnvironmentId', async () => {
    const result = await new SubagentTool().execute(
      assignment({ type: 'browser', browserEnvironmentId: 'environment-a' }),
      createContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain('未绑定浏览器环境');
  });
});
