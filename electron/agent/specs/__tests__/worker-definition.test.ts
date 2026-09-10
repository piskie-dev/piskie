import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sample-app', getAppPath: () => '/tmp/sample-app' } }));

import { SpecRegistry } from '../spec-registry.js';
import { getStandaloneToolCatalog } from '../../../tools/index.js';
import { exploreDefinition } from '../builtin/explore.js';
import { BUILTIN_WORKER_DEFINITIONS } from '../builtin/index.js';
import { workerDefinitionSchema, type WorkerDefinition } from '../worker-definition.js';

const catalog = getStandaloneToolCatalog();
const custom = (): WorkerDefinition => ({ ...structuredClone(exploreDefinition), name: 'sample-investigator' });

describe('WorkerDefinition registration', () => {
  it('compiles serializable builtins and custom declarations through the same entry', () => {
    const registry = new SpecRegistry();
    for (const definition of [...BUILTIN_WORKER_DEFINITIONS, custom()]) {
      const spec = registry.registerWorker(JSON.parse(JSON.stringify(definition)), catalog);
      expect(registry.get(definition.name)).toBe(spec);
      expect(spec).toMatchObject({ name: definition.name, role: 'worker', assignment: definition.assignment });
    }
    const types = registry.getWorkersForParent('director');
    expect(types.map((type) => type.name)).toEqual(['browser-worker', 'explore', 'local-worker', 'sample-investigator']);
    expect(types.find((type) => type.name === 'sample-investigator')).toMatchObject({
      assignment: 'question', browser: false, skills: false,
      description: `${exploreDefinition.description}（工具：read、glob、grep、ls、send_event）`,
    });
    const shared = 'web_search、read、write、edit、glob、grep、ls、shell、tool_search、task、send_event、generate_image、load_skill、skill_call';
    expect(types.find((type) => type.name === 'browser-worker')?.description).toMatch(
      new RegExp(`（工具：browser_\\* 浏览器操作、${shared}）$`)
    );
    expect(types.find((type) => type.name === 'local-worker')?.description).toMatch(new RegExp(`（工具：${shared}）$`));
  });

  it('validates selected tools, their options, and the required reporting and assignment capabilities', () => {
    const register = (definition: WorkerDefinition) => new SpecRegistry().registerWorker(definition, catalog);
    expect(() => register({ ...custom(), tools: [{ name: 'unregistered-tool' }] })).toThrow(/Unknown tool/);
    expect(() => register({ ...custom(), tools: [{ name: 'subagent' }] })).toThrow(/not available/);
    expect(() => register({ ...custom(), tools: [{ name: 'read', options: { events: [] } }] })).toThrow(/does not accept/);
    expect(() => register({ ...custom(), tools: [{ name: 'send_event', options: { events: ['message'] } }] })).toThrow(/must report/);
    expect(() => register({ ...custom(), tools: [{ name: 'send_event', options: { events: ['completed', 'unknown'] } }] })).toThrow();
    expect(() => register({ ...custom(), assignment: 'task-board' })).toThrow(/Task-board/);
    expect(() => register({ ...custom(), tools: [...custom().tools, { name: 'task' }] })).toThrow(/question/);
    expect(() => register({ ...custom(), tools: [...custom().tools, { name: 'read' }] })).toThrow(/unique/);
  });

  it('publishes registered tool option schemas and rejects unsupported declaration fields', () => {
    const sendEvent = catalog.configurationDefinitions().find((tool) => tool.name === 'send_event')!;
    expect(sendEvent.optionsSchema).toMatchObject({ properties: { events: { type: 'array' } }, additionalProperties: false });
    expect(() => catalog.configure('send_event', { unknown: true })).toThrow();
    expect(workerDefinitionSchema.safeParse({ ...custom(), unknown: true }).success).toBe(false);
  });

  it('keeps a registered Worker independent of later edits to its source declaration', () => {
    const definition = custom();
    const spec = new SpecRegistry().registerWorker(definition, catalog);
    definition.tools[0].name = 'write';
    definition.instructions = 'changed';
    expect(spec.tools.customTools[0]).toBe('read');
    const prompt = spec.buildSystemPrompt({ agentId: 'worker-a', role: 'worker', canManageAgentRuns: false,
      skillDocs: '', workspaceDir: '/workspace', tempDir: '/tmp/sample' });
    expect(prompt).toContain('围绕 Assignment 中的问题查明事实');
  });
});
