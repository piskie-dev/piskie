/**
 * SpecRegistry — AgentSpec 注册表
 * 注册、查询、验证 AgentSpec 定义。
 */

import type { AgentSpec } from './spec.js';
import type { SubagentMode } from '../../../shared/types/index.js';
import type { SubagentTypeDescriptor } from '../../tools/types.js';
const PROTECTED_BROWSER_SKILL_TOOLS = Object.freeze(
  new Map<string, string>([
    ['browser_skill_build', 'browser-skill-builder'],
    ['browser_skill_status', 'browser-skill-director'],
    ['browser_skill_publish', 'browser-skill-director'],
  ])
);
const BASE_WORKER_SPECS = new Set(['browser-worker', 'local-worker']);

export function deriveWorkerMode(spec: AgentSpec): SubagentMode {
  if (spec.role !== 'worker') {
    throw new Error(`AgentSpec '${spec.name}' is not a Worker and cannot be created as a subagent`);
  }
  const hasBrowser = spec.modules.includes('browser');
  if (hasBrowser) return 'browser';
  return 'local';
}

export class SpecRegistry {
  private specs = new Map<string, AgentSpec>();

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

  /** Resolve a Worker spec from the trusted override or its base mode. */
  resolveWorkerSpec(config: { mode: string; agentSpec?: string }): string {
    if (config.agentSpec) return config.agentSpec;
    if (config.mode === 'browser') return 'browser-worker';
    return 'local-worker';
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

  /** 当前 Director 获准创建且需要按名称调用的专属 Worker。 */
  getNamedWorkersForParent(parentSpec: string): SubagentTypeDescriptor[] {
    return [...this.specs.values()]
      .filter(
        (spec) =>
          spec.role === 'worker' &&
          !BASE_WORKER_SPECS.has(spec.name) &&
          (!spec.allowedParentSpecs || spec.allowedParentSpecs.includes(parentSpec))
      )
      .map((spec) => ({
        name: spec.name,
        mode: deriveWorkerMode(spec),
        description:
          spec.subagentTypeDescription ??
          `已注册的${deriveWorkerMode(spec) === 'browser' ? '浏览器' : '本地'} Worker`,
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
    } else if (spec.subagentTypeDescription !== undefined) {
      throw new Error(`'${spec.name}' subagentTypeDescription requires allowedParentSpecs`);
    }

    const hasSubagentTool = spec.tools.customTools.includes('subagent');
    const hasSubagentModule = spec.modules.includes('subagent');
    if (hasSubagentTool !== hasSubagentModule) {
      throw new Error(`'${spec.name}' must pair the subagent tool with the subagent module`);
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
