import type {
  ITool,
  ToolContext,
  ToolEffect,
  ToolPolicy,
  ToolScope,
} from '../../../tools/types.js';
import {
  z,
  type DefinedSkill,
  type SkillDomain,
  type SkillFunction,
  type SkillFunctions,
} from './author-api.js';

export {
  bool,
  defineSkill,
  fail,
  int,
  num,
  ok,
  skillToolName,
  z,
  type BrowserSkillRuntime,
  type DefinedSkill,
  type ImageRef,
  type SkillContext,
  type SkillContextBase,
  type SkillDomain,
  type SkillFunction,
  type SkillFunctions,
  type ToolOutput,
} from './author-api.js';

export type SkillProvenance = Readonly<{
  root: string;
  trust: 'builtin' | 'custom';
  entryPoint: 'direct' | 'skill_call';
}>;

export type LoadedSkillModule<
  D extends SkillDomain,
  F extends SkillFunctions<D>,
> = Readonly<{
  name: string;
  domain: D;
  functions: F;
  provenance: SkillProvenance;
}>;

type ParamsOf<TFunction extends SkillFunction<z.ZodObject, SkillDomain, unknown>> =
  z.infer<TFunction['params']>;

export type DomainDescriptor<
  D extends SkillDomain,
  F extends SkillFunctions<D>,
> = Readonly<{
  domain: D;
  scope: ToolScope;
  effects: readonly ToolEffect[];
  policy?: { readonly [K in keyof F]?: ToolPolicy<ParamsOf<F[K]>> };
  makeContext(ctx: ToolContext): any;
  wrapExecute?: {
    readonly [K in keyof F]?: (
      base: ITool<ParamsOf<F[K]>, unknown>,
    ) => ITool<ParamsOf<F[K]>, unknown>;
  };
}>;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BROWSER_HOST_PARAMETER_NAMES = new Set([
  'agentid',
  'browserid',
  'callid',
  'executorid',
  'taskid',
]);

/** Runtime boundary used by the loader before provenance is attached. */
export function assertDefinedSkill(value: unknown): asserts value is DefinedSkill<SkillDomain, SkillFunctions> {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Skill module default export must be a defineSkill object');
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(['name', 'domain', 'functions']);
  const unexpected = Object.keys(candidate).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(`Skill module contains unsupported fields: ${unexpected.join(', ')}`);
  }
  if (typeof candidate.name !== 'string' || !SKILL_NAME.test(candidate.name)) {
    throw new TypeError('Skill name must contain lowercase letters, numbers, and hyphens');
  }
  if (!['local', 'browser'].includes(String(candidate.domain))) {
    throw new TypeError(`Unsupported skill domain: ${String(candidate.domain)}`);
  }
  if (!candidate.functions || typeof candidate.functions !== 'object' || Array.isArray(candidate.functions)) {
    throw new TypeError('Skill functions must be an object');
  }
  if (
    candidate.domain === 'browser'
    && Object.keys(candidate.functions as Record<string, unknown>).length === 0
  ) {
    throw new TypeError('Browser Skill requires at least one callable business function');
  }
  for (const [name, fnValue] of Object.entries(candidate.functions as Record<string, unknown>)) {
    if (!fnValue || typeof fnValue !== 'object') {
      throw new TypeError(`Skill function ${name} must be an object`);
    }
    const fn = fnValue as Record<string, unknown>;
    if (typeof fn.description !== 'string' || !fn.description.trim()) {
      throw new TypeError(`Skill function ${name} requires description`);
    }
    if (!(fn.params instanceof z.ZodObject)) {
      throw new TypeError(`Skill function ${name} requires an object-shaped zod params schema`);
    }
    if (candidate.domain === 'browser') {
      const hostParameters = browserHostParameterPaths(fn.params);
      if (hostParameters.length > 0) {
        throw new TypeError(
          `Browser Skill function ${name} cannot expose host runtime parameters: ${hostParameters.join(', ')}`,
        );
      }
    }
    if (typeof fn.run !== 'function') {
      throw new TypeError(`Skill function ${name} requires run`);
    }
  }
}

function browserHostParameterPaths(schema: z.ZodObject): string[] {
  const document = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
  const found = new Set<string>();
  const seen = new Set<object>();

  const visit = (value: unknown, parentPath: readonly string[]): void => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, parentPath);
      return;
    }

    const node = value as Record<string, unknown>;
    const properties = node.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [property, child] of Object.entries(properties as Record<string, unknown>)) {
        const propertyPath = [...parentPath, property];
        if (BROWSER_HOST_PARAMETER_NAMES.has(property.toLowerCase())) {
          found.add(propertyPath.join('.'));
        }
        visit(child, propertyPath);
      }
    }

    visit(node.items, parentPath);
    visit(node.additionalProperties, parentPath);
    for (const keyword of ['allOf', 'anyOf', 'oneOf', '$defs', 'definitions'] as const) {
      visit(node[keyword], parentPath);
    }
  };

  visit(document, []);
  return [...found].sort();
}

export function attachSkillProvenance<
  D extends SkillDomain,
  F extends SkillFunctions<D>,
>(skill: DefinedSkill<D, F>, provenance: SkillProvenance): LoadedSkillModule<D, F> {
  return Object.freeze({
    name: skill.name,
    domain: skill.domain,
    functions: skill.functions,
    provenance: Object.freeze({ ...provenance }),
  });
}
