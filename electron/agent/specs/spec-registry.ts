/**
 * SpecRegistry — AgentSpec 注册表
 * 注册、查询、验证 AgentSpec 定义。
 */

import type { AgentSpec } from './spec.js';
import type { SubagentTypeDescriptor } from '../../tools/types.js';
import type { ToolCatalog } from '../../tools/catalog.js';
import { workerDefinitionSchema, type WorkerDefinition } from './worker-definition.js';
import { assemble } from '../prompts/assemble.js';
const PROTECTED_BROWSER_SKILL_TOOLS = Object.freeze(
  new Map<string, string>([
    ['browser_skill_build', 'browser-skill-builder'],
    ['browser_skill_status', 'browser-skill-director'],
    ['browser_skill_publish', 'browser-skill-director'],
  ])
);

/** Type description shown to the parent model: the declared purpose plus the granted tool list. */
/** 技能组工具统一以 `${skill}_` 为前缀，清单里用通配代表整组，并排在共有工具之前。 */
function describeWorkerType(spec: AgentSpec): string {
  const purpose = spec.subagentTypeDescription ?? spec.name;
  const skillGroups = (spec.tools.sdkGroups ?? []).map((skill) =>
    skill === 'browser' ? 'browser_* 浏览器操作' : `${skill}_*`
  );
  const custom = spec.tools.customTools.filter((name) => !spec.tools.exclude?.includes(name));
  const tools = [...skillGroups, ...custom];
  return tools.length ? `${purpose}（工具：${tools.join('、')}）` : purpose;
}

export class SpecRegistry {
  private specs = new Map<string, AgentSpec>();

  registerWorker(input: WorkerDefinition, catalog: ToolCatalog): AgentSpec {
    const definition = workerDefinitionSchema.parse(input);
    const names = definition.tools.map((tool) => tool.name);
    if (new Set(names).size !== names.length) throw new Error('Worker tool names must be unique');
    const excluded = new Set(definition.excludedTools ?? []);
    const granted = names.filter((name) => !excluded.has(name));
    const options = Object.fromEntries(definition.tools.map((tool) => [
      tool.name, catalog.configure(tool.name, tool.options, 'subagent'),
    ]));
    if (!granted.includes('send_event')) throw new Error('Worker requires send_event for result reporting');
    const events = options.send_event.events as readonly string[];
    if (!['completed', 'failed', 'user_stopped'].every((event) => events.includes(event))) {
      throw new Error('Worker must report completed, failed, and user_stopped');
    }
    if ((definition.assignment === 'task-board') !== granted.includes('task')) {
      throw new Error('Task-board assignments require task; question assignments use independent results');
    }
    const browser = definition.resources?.browser;
    const spec: AgentSpec = {
      name: definition.name,
      role: 'worker',
      assignment: definition.assignment,
      subagentTypeDescription: definition.description,
      tools: {
        customTools: names,
        sdkGroups: browser ? ['browser'] : [],
        options,
        exclude: definition.excludedTools,
      },
      modules: [...(browser ? ['browser'] : []), ...(definition.resources?.image ? ['image'] : [])],
      allowedParentSpecs: definition.allowedParentSpecs,
      shareDirectorBrowser: browser?.shareWithParent,
      lifecycle: definition.lifecycle,
      mcpServers: definition.mcpServers,
      buildSystemPrompt: (ctx) => assemble({
        includeSkillDocs: definition.includeSkillDocs ?? granted.includes('load_skill'),
        render: () => definition.instructions,
      }, {
        ...ctx,
        role: 'worker',
        assignment: definition.assignment,
        toolNames: ctx.toolNames ?? granted,
        sendEventTypes: ctx.sendEventTypes ?? events,
      }),
    };
    this.register(spec);
    return spec;
  }

  /**
   * 注册一个 AgentSpec
   * @throws 如果 name 重复或验证不通过
   */
  register(spec: AgentSpec): void {
    if (this.specs.has(spec.name)) {
      throw new Error(`AgentSpec '${spec.name}' already registered`);
    }
    this.validate(spec);
    this.specs.set(spec.name, spec);
  }

  /** 注销一个 AgentSpec（用于自定义类型的删除/更新） */
  unregister(name: string): boolean {
    return this.specs.delete(name);
  }

  /** 按名称获取 */
  get(name: string): AgentSpec | undefined {
    return this.specs.get(name);
  }

  /** 是否存在 */
  has(name: string): boolean {
    return this.specs.has(name);
  }

  /** 获取所有已注册 Spec */
  getAll(): AgentSpec[] {
    return Array.from(this.specs.values());
  }

  /** 领域专属 Worker 的创建权限由 AgentSpec 决定，不从 Assignment 文本推断。 */
  assertParentMayCreate(parentSpec: string, childSpec: AgentSpec): void {
    const allowed = childSpec.allowedParentSpecs;
    if (!allowed) return;
    if (!allowed.includes(parentSpec)) {
      throw new Error(
        `AgentSpec '${parentSpec}' cannot create protected Worker '${childSpec.name}'`
      );
    }
  }

  /** 当前父代理获准创建的 Worker 及其输入能力。 */
  getWorkersForParent(parentSpec: string): SubagentTypeDescriptor[] {
    return [...this.specs.values()]
      .filter(
        (spec) =>
          spec.role === 'worker' &&
          (!spec.allowedParentSpecs || spec.allowedParentSpecs.includes(parentSpec))
      )
      .map((spec) => ({
        name: spec.name,
        assignment: spec.assignment ?? 'task-board',
        browser: spec.modules.includes('browser'),
        skills: spec.tools.customTools.includes('load_skill') && !spec.tools.exclude?.includes('load_skill'),
        description: describeWorkerType(spec),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** 验证 AgentSpec 定义的一致性 */
  private validate(spec: AgentSpec): void {
    if (
      !spec.name.trim() ||
      spec.name !== spec.name.trim() ||
      spec.name === '.' ||
      spec.name === '..' ||
      /[\\/\0]/.test(spec.name)
    ) {
      throw new Error(`AgentSpec name '${spec.name}' is not a path-safe identifier`);
    }

    for (const toolName of spec.tools.customTools) {
      const owner = PROTECTED_BROWSER_SKILL_TOOLS.get(toolName);
      if (owner && spec.name !== owner) {
        throw new Error(
          `AgentSpec '${spec.name}' cannot declare protected tool '${toolName}' (owner: '${owner}')`
        );
      }
    }

    const hasBrowserModule = spec.modules.includes('browser');

    if (spec.role === 'worker') {
      const hasBrowserSdk = spec.tools.sdkGroups.includes('browser');
      if (hasBrowserModule !== hasBrowserSdk) {
        throw new Error(`Worker '${spec.name}' must pair the browser module with 'browser'`);
      }
    }
    if (spec.shareDirectorBrowser && (spec.role !== 'worker' || !hasBrowserModule)) {
      throw new Error(`'${spec.name}' shareDirectorBrowser requires a browser Worker`);
    }

    if (spec.lifecycle && spec.role !== 'worker') {
      throw new Error(`'${spec.name}' lifecycle is only valid for Worker specs`);
    }
    if (spec.allowedParentSpecs) {
      if (spec.role !== 'worker') {
        throw new Error(`'${spec.name}' allowedParentSpecs is only valid for Worker specs`);
      }
      if (
        spec.allowedParentSpecs.length === 0 ||
        new Set(spec.allowedParentSpecs).size !== spec.allowedParentSpecs.length
      ) {
        throw new Error(`Worker '${spec.name}' must declare unique, non-empty allowedParentSpecs`);
      }
      if (spec.allowedParentSpecs.some((name) => !name.trim())) {
        throw new Error(`Worker '${spec.name}' contains an empty allowed parent spec`);
      }
      if (!spec.subagentTypeDescription?.trim()) {
        throw new Error(`Protected Worker '${spec.name}' must declare subagentTypeDescription`);
      }
    }

    const hasSubagentTool = spec.tools.customTools.includes('subagent') || spec.tools.customTools.includes('subagent_stop');
    const hasSubagentModule = spec.modules.includes('subagent');
    if (hasSubagentTool !== hasSubagentModule) {
      throw new Error(`'${spec.name}' must pair the subagent/subagent_stop tools with the subagent module`);
    }
    if ((hasSubagentTool || hasSubagentModule) && spec.role !== 'director') {
      throw new Error(`'${spec.name}' may use the subagent tool/module only as a director`);
    }
    if (spec.tools.customTools.includes('agent_run') && spec.role !== 'director') {
      throw new Error(
        `'${spec.name}' has 'agent_run' but role is '${spec.role}' — agent_run 仅限 director 角色`
      );
    }
  }
}

export const specRegistry = new SpecRegistry();
