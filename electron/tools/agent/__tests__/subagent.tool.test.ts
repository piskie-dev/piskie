import { describe, expect, it, vi } from 'vitest';
import { SubagentTool } from '../subagent.tool.js';
import { ToolCatalog } from '../../catalog.js';
import { parse } from '../../params.js';
import type { SubagentTypeDescriptor, ToolContext } from '../../types.js';

const types: SubagentTypeDescriptor[] = [
  { name: 'explore', description: '调查本地材料', assignment: 'question', browser: false, skills: false },
  { name: 'local-worker', description: '本地执行', assignment: 'work-package', browser: false, skills: true },
  { name: 'browser-worker', description: '网站执行', assignment: 'work-package', browser: true, skills: true },
  { name: 'site-scout', description: '侦察网站', assignment: 'work-package', browser: true, skills: false },
];

function snapshot(subagentTypes: SubagentTypeDescriptor[] = types) {
  const catalog = new ToolCatalog();
  catalog.register(new SubagentTool(), 'builtin');
  return catalog.snapshot({
    scope: 'main', agentType: 'main', customTools: ['subagent'],
    exposedSkillFunctions: [], excluded: new Set(), domains: new Set(['local']),
    subagentTypes,
  });
}

const question = { type: 'explore', subject: '查明保存入口', prompt: '阅读 /workspace/sample 中的配置保存链路，返回路径与行号。' };
const assignment = { ...question, type: 'local-worker' };

function validate(raw: unknown) {
  return parse(snapshot().resolve('subagent')!.contract.schema, raw);
}

describe('subagent resolved creation contract', () => {
  it('projects registered types and only the fields required by each type', () => {
    const schema = snapshot().definitions()[0].input_schema;
    expect(schema.properties.type).toMatchObject({ enum: types.map((type) => type.name) });
    expect(schema.properties).not.toHaveProperty('action');
    expect(schema.properties).not.toHaveProperty('subagentId');
    // 会话可中途加入环境，所以 schema 只描述字段，成员资格在执行时按实时集合校验。
    expect(schema.properties.browserEnvironmentId).toMatchObject({ type: 'string' });
    expect(schema.properties.browserEnvironmentId).not.toHaveProperty('enum');
    expect(schema.properties.browserEnvironmentId.description).toContain('已加入会话');
    expect(schema.oneOf).toContainEqual({
      properties: { type: { const: 'explore' }, subject: {}, prompt: {} },
      required: ['type', 'subject', 'prompt'], additionalProperties: false,
    });
    expect(schema.properties.prompt).toMatchObject({ description: '交给 Worker 的任务或问题' });
    expect(schema.properties.type.description).toContain('见工具描述');
    expect(schema.properties.type.description).not.toContain('调查本地材料');
    expect(snapshot(types.filter((type) => !type.browser)).definitions()[0].input_schema.properties)
      .not.toHaveProperty('browserEnvironmentId');
  });

  it('lists Worker types in the description body, before the handoff', () => {
    const description = snapshot().definitions()[0].description;
    expect(description).toContain('可用的 Worker 类型：\n- explore：调查本地材料\n- local-worker：本地执行');
    expect(description.indexOf('可用的 Worker 类型')).toBeLessThan(description.indexOf('刚走进房间的聪明同事'));
    expect(description.endsWith('prompt 是它拿到的全部材料。')).toBe(true);
  });

  it('describes the handoff once and never mentions the Task Board', () => {
    const description = snapshot().definitions()[0].description;
    expect(description).toContain('把新的 Worker 当作一位刚走进房间的聪明同事来交接：它能力完整，可以自主判断；prompt 是它拿到的全部材料。');
    expect(description).not.toContain('Task Board');
    expect(description).not.toMatch(/explore 接收|自包含|action=stop/);
    expect(snapshot(types.filter((type) => type.assignment === 'question')).definitions()[0].description)
      .not.toContain('Task Board');
  });

  it('keeps a well-formed schema when no Worker type is available', () => {
    const empty = snapshot([]);
    expect(empty.definitions()[0].input_schema.properties).toHaveProperty('type');
    expect(empty.definitions()[0].description).not.toContain('可用的 Worker 类型');
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
    expect(validate({ ...question, ...extra }).ok).toBe(false);
  });

  it.each([
    { type: undefined }, { type: 'unknown-worker' }, { type: 'director' },
    { subject: ' ' }, { subject: 'x'.repeat(41) }, { prompt: ' ' }, { action: 'create' }, { subagentId: 'worker-a' },
  ])('validates the current public creation fields: %j', (extra) => {
    expect(validate({ ...question, ...extra }).ok).toBe(false);
  });

  it('accepts a work package with the declared optional skills', () => {
    expect(validate(assignment).ok).toBe(true);
    for (const taskIds of [[], ['task-a'], ['task-a', 'task-a']]) {
      expect(validate({ ...assignment, taskIds }).ok).toBe(false);
    }
    expect(validate({ ...assignment, skills: ['sample-skill'] }).ok).toBe(true);
    expect(validate({ ...assignment, type: 'site-scout', skills: ['sample-skill'] }).ok).toBe(false);
  });

  it('accepts any stable environment ID for browser resources and none for local ones', () => {
    const browser = { ...assignment, type: 'browser-worker' };
    expect(validate(browser).ok).toBe(true);
    expect(validate({ ...browser, browserEnvironmentId: 'environment-a' })).toMatchObject({
      ok: true, value: { browserEnvironmentId: 'environment-a' },
    });
    expect(validate({ ...browser, browserEnvironmentId: 'environment-joined-later' }).ok).toBe(true);
    expect(validate({ ...browser, browserEnvironmentId: 42 }).ok).toBe(false);
    expect(validate({ ...assignment, browserEnvironmentId: 'environment-a' }).ok).toBe(false);
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

  it('returns creation failures from the resource owner', async () => {
    const result = await new SubagentTool().execute(assignment, {
      subagents: { create: vi.fn().mockRejectedValue(new Error('Browser resource unavailable')), traceFilePath: vi.fn() },
    } as unknown as ToolContext);
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining('Browser resource unavailable') });
  });
});
