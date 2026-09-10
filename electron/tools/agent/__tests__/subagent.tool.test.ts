import { describe, expect, it, vi } from 'vitest';
import { SubagentTool } from '../subagent.tool.js';
import { ToolCatalog } from '../../catalog.js';
import { parse } from '../../params.js';
import type { SubagentTypeDescriptor, ToolContext } from '../../types.js';

const types: SubagentTypeDescriptor[] = [
  { name: 'explore', description: '调查本地材料', assignment: 'question', browser: false, skills: false },
  { name: 'local-worker', description: '本地执行', assignment: 'task-board', browser: false, skills: true },
  { name: 'browser-worker', description: '网站执行', assignment: 'task-board', browser: true, skills: true },
  { name: 'site-scout', description: '侦察网站', assignment: 'task-board', browser: true, skills: false },
];

function snapshot(environments: string[] = [], subagentTypes: SubagentTypeDescriptor[] = types) {
  const catalog = new ToolCatalog();
  catalog.register(new SubagentTool(), 'builtin');
  return catalog.snapshot({
    scope: 'main', agentType: 'main', customTools: ['subagent'],
    exposedSkillFunctions: [], excluded: new Set(), domains: new Set(['local']),
    subagentTypes, subagentResources: { browserEnvironmentIds: environments },
  });
}

const question = { type: 'explore', subject: '查明保存入口', prompt: '阅读 /workspace/sample 中的配置保存链路，返回路径与行号。' };
const assignment = { ...question, type: 'local-worker', taskIds: ['task-a'] };

function validate(raw: unknown, environments: string[] = []) {
  return parse(snapshot(environments).resolve('subagent')!.contract.schema, raw);
}

describe('subagent resolved creation contract', () => {
  it('projects registered types and only the fields required by each type', () => {
    const schema = snapshot(['environment-a']).definitions()[0].input_schema;
    expect(schema.properties.type).toMatchObject({ enum: types.map((type) => type.name) });
    expect(schema.properties).not.toHaveProperty('action');
    expect(schema.properties).not.toHaveProperty('subagentId');
    expect(schema.properties.browserEnvironmentId).toMatchObject({ enum: ['environment-a'] });
    expect(schema.oneOf).toContainEqual({
      properties: { type: { const: 'explore' }, subject: {}, prompt: {} },
      required: ['type', 'subject', 'prompt'], additionalProperties: false,
    });
    expect(schema.properties.prompt).toMatchObject({ description: '交给 Worker 的任务或问题' });
    expect(snapshot().definitions()[0].input_schema.properties).not.toHaveProperty('browserEnvironmentId');
  });

  it('describes the handoff once and the task-board split only for task-board types', () => {
    const description = snapshot().definitions()[0].description;
    expect(description).toContain('刚走进房间的聪明同事');
    expect(description).toContain('local-worker、browser-worker、site-scout：先在 Task Board 登记任务');
    expect(description).not.toMatch(/explore 接收|自包含|action=stop/);
    expect(snapshot([], types.filter((type) => type.assignment === 'question')).definitions()[0].description)
      .not.toContain('Task Board');
  });

  it('keeps a well-formed schema when no Worker type is available', () => {
    const empty = snapshot([], []);
    expect(empty.definitions()[0].input_schema.properties).toHaveProperty('type');
    expect(parse(empty.resolve('subagent')!.contract.schema, question)).toMatchObject({ ok: false });
  });

  it('accepts an independent question and normalizes its title', () => {
    expect(validate({ ...question, subject: ' 调查保存入口 ' })).toEqual({
      ok: true, value: { ...question, subject: '调查保存入口' },
    });
  });

  it.each([
    { taskIds: ['task-a'] }, { skills: ['sample-skill'] }, { browserEnvironmentId: 'environment-a' },
  ])('restricts question input to its declared fields: %j', (extra) => {
    expect(validate({ ...question, ...extra }, ['environment-a']).ok).toBe(false);
  });

  it.each([
    { type: undefined }, { type: 'unknown-worker' }, { type: 'director' },
    { subject: ' ' }, { subject: 'x'.repeat(41) }, { prompt: ' ' }, { action: 'create' }, { subagentId: 'worker-a' },
  ])('validates the current public creation fields: %j', (extra) => {
    expect(validate({ ...question, ...extra }).ok).toBe(false);
  });

  it('requires a nonempty unique task list for execution Workers', () => {
    expect(validate(assignment).ok).toBe(true);
    for (const taskIds of [undefined, [], ['task-a', 'task-a']]) {
      expect(validate({ ...assignment, taskIds }).ok).toBe(false);
    }
    expect(validate({ ...assignment, skills: ['sample-skill'] }).ok).toBe(true);
    expect(validate({ ...assignment, type: 'site-scout', skills: ['sample-skill'] }).ok).toBe(false);
  });

  it('requires a bound environment only for browser resources', () => {
    const browser = { ...assignment, type: 'browser-worker' };
    expect(validate(browser).ok).toBe(true);
    expect(validate(browser, ['environment-a']).ok).toBe(false);
    expect(validate({ ...browser, browserEnvironmentId: 'environment-b' }, ['environment-a']).ok).toBe(false);
    expect(validate({ ...browser, browserEnvironmentId: 'environment-a' }, ['environment-a']).ok).toBe(true);
    expect(validate({ ...browser, browserEnvironmentId: 'environment-a' }).ok).toBe(false);
    expect(validate(assignment, ['environment-a']).ok).toBe(true);
  });

  it('passes the prepared question to the single creation entry and returns its identity', async () => {
    const create = vi.fn().mockResolvedValue('worker-a');
    const parsed = validate(question);
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const result = await new SubagentTool().execute(parsed.value, {
      subagents: { create, destroy: vi.fn(), traceFilePath: () => '/tmp/worker-a.trace.md' },
    } as unknown as ToolContext);
    expect(create).toHaveBeenCalledWith({ type: 'explore', subject: question.subject, prompt: question.prompt });
    expect(result).toMatchObject({ ok: true, data: { type: 'explore', subagentId: 'worker-a' } });
    expect(result.text).toContain('无需轮询');
  });

  it('returns creation failures from the resource and task owners', async () => {
    const result = await new SubagentTool().execute(assignment, {
      subagents: { create: vi.fn().mockRejectedValue(new Error('Missing task-a')), traceFilePath: vi.fn() },
    } as unknown as ToolContext);
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining('Missing task-a') });
  });
});
