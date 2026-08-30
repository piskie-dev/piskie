import type {
  SkillDomain,
  SkillProvenance,
} from '../piskiepilot/core/skill/define.js';
import type { McpOrigin, McpTransportKind } from '../../shared/types/mcp.js';
import { toToolInputSchema } from './params.js';
import type {
  DeferredToolsPort,
  ITool,
  SubagentTypeDescriptor,
  ToolAgentType,
  ToolDefinition,
  ToolScope,
} from './types.js';

export type SkillCatalogIdentity = Readonly<{
  kind: 'skill';
  skill: string;
  function: string;
  domain: SkillDomain;
  entryPoint: 'direct' | 'skill_call';
}>;

export type McpCatalogIdentity = Readonly<{
  kind: 'mcp';
  server: string;
  /** raw 协议名（调用时上协议用；modelName 是 sanitize 后的可见名） */
  tool: string;
  transport: McpTransportKind;
  origin: McpOrigin;
}>;

export type CatalogIdentity = SkillCatalogIdentity | McpCatalogIdentity;

function asSkillIdentity(entry: CatalogEntry): SkillCatalogIdentity | undefined {
  return entry.identity?.kind === 'skill' ? entry.identity : undefined;
}

export type CatalogEntry = Readonly<{
  modelName: string;
  tool: ITool<any, any>;
  trust: 'builtin' | 'custom';
  identity?: CatalogIdentity;
  /**
   * 注入形态：direct 直接进工具表；deferred 只在清单里留名字行，
   * 经 tool_search 装载后 schema 才进工具表（隐藏条目不注册，没有第三态）。
   * 缺省 direct。
   */
  exposure?: 'direct' | 'deferred';
  /**
   * 原样 JSON Schema 的工具定义（MCP 工具没有 zod schema，注入用 server
   * 下发的 inputSchema 原文）。存在时 asDefinition 直接采用。
   */
  definitionOverride?: ToolDefinition;
}>;

export type CatalogSkillEntryInput = Readonly<{
  tool: ITool<any, any>;
  identity: SkillCatalogIdentity;
}>;

export type SkillFunctionResolution =
  | { kind: 'resolved'; entry: CatalogEntry }
  | { kind: 'directOnly'; modelName: string }
  | { kind: 'unknownFunction'; available: readonly string[] }
  | { kind: 'notEligible'; reason: 'scope' | 'excluded' | 'resource' | 'notExposed' }
  | { kind: 'notCallable' };

export type FinalToolFace = Readonly<{
  scope: ToolScope;
  agentType: ToolAgentType;
  customTools: readonly string[];
  exposedSkillFunctions: readonly string[];
  excluded: ReadonlySet<string>;
  domains: ReadonlySet<SkillDomain>;
  subagentTypes?: readonly SubagentTypeDescriptor[];
  subagentResources?: Readonly<{
    browserEnvironmentIds: readonly string[];
  }>;
}>;

export type CatalogProjection = Readonly<{
  /** 当前模型边界已发布的 Agent 专属条目；快照构造时会再次拷贝。 */
  entries?: readonly CatalogEntry[];
  /** Candidate 可遮蔽同名已安装 Skill，但不能遮蔽原生工具或其他 Skill。 */
  replaceSkills?: readonly string[];
}>;

export type DeferredToolListing = Readonly<{
  modelName: string;
  server: string;
  description: string;
}>;

export interface CatalogSnapshot {
  resolve(modelName: string): CatalogEntry | undefined;
  /** deferred 条目的解析（无论是否已装载；装载检查由调用方做） */
  resolveDeferred(modelName: string): CatalogEntry | undefined;
  /** direct 定义 + 已装载的 deferred 定义（追加式投影） */
  definitions(loadedDeferred?: ReadonlySet<string>): ToolDefinition[];
  deferredTools(): readonly DeferredToolListing[];
  resolveSkillFunction(skill: string, functionName: string): SkillFunctionResolution;
}

/** 运行段内 deferred 覆盖集：装载即迁出，投影只增不减。 */
export function createDeferredToolsPort(
  snapshot: () => CatalogSnapshot,
  loaded: Set<string>,
): DeferredToolsPort {
  return {
    list: () => snapshot().deferredTools().filter((tool) => !loaded.has(tool.modelName)),
    load: (names) => {
      const available = new Set(
        snapshot().deferredTools()
          .filter((tool) => !loaded.has(tool.modelName))
          .map((tool) => tool.modelName),
      )
      const accepted: string[] = []
      const unknown: string[] = []
      for (const name of [...new Set(names)]) {
        if (available.has(name)) {
          loaded.add(name)
          accepted.push(name)
        } else {
          unknown.push(name)
        }
      }
      return { loaded: accepted, unknown }
    },
  }
}

function scopeAllows(scope: ToolScope, face: FinalToolFace): boolean {
  return scope === 'shared' || scope === face.scope;
}

function eligible(
  entry: CatalogEntry,
  face: FinalToolFace,
): 'scope' | 'excluded' | 'resource' | undefined {
  if (!scopeAllows(entry.tool.def.scope, face)) return 'scope';
  if (face.excluded.has(entry.modelName)) return 'excluded';
  const skillIdentity = asSkillIdentity(entry);
  if (skillIdentity && !face.domains.has(skillIdentity.domain)) return 'resource';
  return undefined;
}

function directlyExposed(entry: CatalogEntry, face: FinalToolFace): boolean {
  if (eligible(entry, face)) return false;
  if (entry.identity?.kind === 'mcp') return (entry.exposure ?? 'direct') === 'direct';
  const skillIdentity = asSkillIdentity(entry);
  if (!skillIdentity) return face.customTools.includes(entry.modelName);
  return (
    skillIdentity.entryPoint === 'direct'
    && face.exposedSkillFunctions.includes(entry.modelName)
  );
}

function asDefinition(entry: CatalogEntry, face: FinalToolFace): ToolDefinition {
  if (entry.definitionOverride) return entry.definitionOverride;
  const { def } = entry.tool;
  const inputSchema = toToolInputSchema(def.schema);
  return {
    name: entry.modelName,
    description: typeof def.description === 'function'
      ? def.description(face.agentType)
      : def.description,
    input_schema: def.modelInputSchema?.(inputSchema, {
      agentType: face.agentType,
      subagentTypes: face.subagentTypes ?? [],
      subagentResources: face.subagentResources ?? {
        browserEnvironmentIds: [],
      },
    }) ?? inputSchema,
  };
}

class FrozenCatalogSnapshot implements CatalogSnapshot {
  private readonly entries: readonly CatalogEntry[];
  private readonly direct: ReadonlyMap<string, CatalogEntry>;
  private readonly deferred: ReadonlyMap<string, CatalogEntry>;
  private readonly definitionsValue: readonly ToolDefinition[];

  constructor(
    entries: readonly CatalogEntry[],
    private readonly face: FinalToolFace,
    projection: CatalogProjection = {},
  ) {
    const replaced = new Set(projection.replaceSkills ?? []);
    const base = replaced.size === 0
      ? entries
      : entries.filter((entry) => {
          const identity = asSkillIdentity(entry);
          return !identity || !replaced.has(identity.skill);
        });
    this.entries = Object.freeze([...base, ...(projection.entries ?? [])]);
    const seen = new Set<string>();
    for (const entry of this.entries) {
      if (seen.has(entry.modelName)) {
        throw new Error(`Catalog projection modelName conflict: ${entry.modelName}`);
      }
      seen.add(entry.modelName);
    }
    const exposed = this.entries.filter((entry) => directlyExposed(entry, face));
    this.direct = new Map(exposed.map((entry) => [entry.modelName, entry]));
    this.deferred = new Map(
      this.entries
        .filter((entry) => entry.exposure === 'deferred' && !eligible(entry, face))
        .map((entry) => [entry.modelName, entry]),
    );
    this.definitionsValue = Object.freeze(
      exposed.map((entry) => Object.freeze(asDefinition(entry, face))),
    );
  }

  resolve(modelName: string): CatalogEntry | undefined {
    return this.direct.get(modelName);
  }

  resolveDeferred(modelName: string): CatalogEntry | undefined {
    return this.deferred.get(modelName);
  }

  definitions(loadedDeferred?: ReadonlySet<string>): ToolDefinition[] {
    const base = [...this.definitionsValue];
    if (!loadedDeferred || loadedDeferred.size === 0) return base;
    for (const [name, entry] of this.deferred) {
      if (loadedDeferred.has(name)) base.push(asDefinition(entry, this.face));
    }
    return base;
  }

  deferredTools(): readonly DeferredToolListing[] {
    return [...this.deferred.values()].map((entry) => ({
      modelName: entry.modelName,
      server: entry.identity?.kind === 'mcp' ? entry.identity.server : '',
      description: asDefinition(entry, this.face).description,
    }));
  }

  resolveSkillFunction(skill: string, functionName: string): SkillFunctionResolution {
    const skillEntries = this.entries.filter((entry) => asSkillIdentity(entry)?.skill === skill);
    if (skillEntries.length === 0) return { kind: 'notCallable' };

    const entry = skillEntries.find(
      (candidate) => asSkillIdentity(candidate)?.function === functionName,
    );
    const identity = entry ? asSkillIdentity(entry) : undefined;
    if (!entry || !identity) {
      return {
        kind: 'unknownFunction',
        available: Object.freeze(
          skillEntries
            .map((candidate) => asSkillIdentity(candidate)?.function)
            .filter((name): name is string => Boolean(name))
            .sort(),
        ),
      };
    }

    const reason = eligible(entry, this.face);
    if (reason) return { kind: 'notEligible', reason };

    if (identity.entryPoint === 'direct') {
      return this.resolve(entry.modelName)
        ? { kind: 'directOnly', modelName: entry.modelName }
        : { kind: 'notEligible', reason: 'notExposed' };
    }
    return { kind: 'resolved', entry };
  }
}

export class ToolCatalog {
  private readonly entries = new Map<string, CatalogEntry>();

  register(
    tool: ITool<any, any>,
    trust: 'builtin' | 'custom',
    identity?: CatalogIdentity,
  ): void {
    const modelName = tool.def.name;
    if (this.entries.has(modelName)) {
      throw new Error(`Catalog modelName conflict: ${modelName}`);
    }
    this.entries.set(modelName, Object.freeze({ modelName, tool, trust, identity }));
  }

  validateSkillReplacement(
    skill: string,
    provenance: SkillProvenance,
    entries: readonly CatalogSkillEntryInput[],
  ): void {
    const seen = new Set<string>();
    const existingSkillEntries = [...this.entries.values()].filter(
      (entry) => asSkillIdentity(entry)?.skill === skill,
    );

    for (const current of existingSkillEntries) {
      const currentIdentity = asSkillIdentity(current);
      if (currentIdentity?.entryPoint !== provenance.entryPoint) {
        throw new Error(
          `Skill ${skill} cannot change entry point from ${currentIdentity?.entryPoint} to ${provenance.entryPoint}`,
        );
      }
    }

    for (const candidate of entries) {
      const { identity, tool } = candidate;
      if (identity.skill !== skill) {
        throw new Error(`Replacement for ${skill} contains entry for ${identity.skill}`);
      }
      if (identity.entryPoint !== provenance.entryPoint) {
        throw new Error(
          `Skill ${skill} entry ${tool.def.name} does not match provenance entry point`,
        );
      }
      if (seen.has(tool.def.name)) {
        throw new Error(`Duplicate modelName in skill replacement: ${tool.def.name}`);
      }
      seen.add(tool.def.name);

      const current = this.entries.get(tool.def.name);
      if (current && asSkillIdentity(current)?.skill !== skill) {
        throw new Error(`Catalog modelName conflict: ${tool.def.name}`);
      }
    }
  }

  replaceSkill(
    skill: string,
    provenance: SkillProvenance,
    entries: readonly CatalogSkillEntryInput[],
  ): void {
    // Callers must finish validateSkillReplacement before their disk commit.
    // This method is the synchronous, non-fallible in-memory commit half.
    for (const [modelName, entry] of this.entries) {
      if (asSkillIdentity(entry)?.skill === skill) this.entries.delete(modelName);
    }
    for (const candidate of entries) {
      const modelName = candidate.tool.def.name;
      this.entries.set(modelName, Object.freeze({
        modelName,
        tool: candidate.tool,
        trust: provenance.trust,
        identity: candidate.identity,
      }));
    }
  }

  /** Remove a complete Skill slice even when its Loader entry is already absent. */
  removeSkill(skill: string): void {
    for (const [modelName, entry] of this.entries) {
      if (asSkillIdentity(entry)?.skill === skill) this.entries.delete(modelName);
    }
  }

  snapshot(face: FinalToolFace, projection: CatalogProjection = {}): CatalogSnapshot {
    return new FrozenCatalogSnapshot([...this.entries.values()], face, projection);
  }
}
