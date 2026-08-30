import type { z } from 'zod';
import type {
  DomainDescriptor,
  LoadedSkillModule,
  SkillDomain,
  SkillFunction,
  SkillFunctions,
} from '../../piskiepilot/core/skill/define.js';
import { skillToolName } from '../../piskiepilot/core/skill/define.js';
import type { CatalogSkillEntryInput } from '../catalog.js';
import type { ParamSpec } from '../params.js';
import type {
  ITool,
  ToolEffect,
  ToolOutput,
  ToolPolicy,
  ToolScope,
  ToolContext,
} from '../types.js';

type ParamsOf<TFunction extends SkillFunction<z.ZodObject, SkillDomain, unknown>> =
  z.infer<TFunction['params']>;

function makeSkillFunctionTool<
  D extends SkillDomain,
  TFunction extends SkillFunction<z.ZodObject, D, unknown>,
>(
  skillName: string,
  functionName: string,
  fn: TFunction,
  scope: ToolScope,
  effects: readonly ToolEffect[],
  makeContext: (ctx: ToolContext) => import('../../piskiepilot/core/skill/define.js').SkillContext<D>,
  policy: ToolPolicy<ParamsOf<TFunction>> | undefined,
): ITool<ParamsOf<TFunction>, unknown> {
  return {
    def: {
      name: skillToolName(skillName, functionName),
      description: fn.description,
      schema: fn.params as ParamSpec<ParamsOf<TFunction>>,
      scope,
      effects: [...effects],
      policy,
    },
    async execute(params, ctx): Promise<ToolOutput<unknown>> {
      return fn.run(params, makeContext(ctx));
    },
  };
}

export function buildSkillEntries<
  D extends SkillDomain,
  F extends SkillFunctions<D>,
>(
  skill: LoadedSkillModule<D, F>,
  descriptor: DomainDescriptor<D, F>,
): CatalogSkillEntryInput[] {
  if (skill.domain !== descriptor.domain) {
    throw new Error(
      `Skill ${skill.name} domain ${skill.domain} does not match descriptor ${descriptor.domain}`,
    );
  }

  const entries: CatalogSkillEntryInput[] = [];
  for (const functionName of Object.keys(skill.functions) as Array<keyof F & string>) {
    const fn = skill.functions[functionName];
    const base = makeSkillFunctionTool(
      skill.name,
      functionName,
      fn,
      descriptor.scope,
      descriptor.effects,
      descriptor.makeContext,
      descriptor.policy?.[functionName],
    );
    const wrap = descriptor.wrapExecute?.[functionName];
    const wrapped = wrap ? wrap(base) : base;
    entries.push({
      tool: wrapped,
      identity: {
        kind: 'skill',
        skill: skill.name,
        function: functionName,
        domain: descriptor.domain,
        entryPoint: skill.provenance.entryPoint,
      },
    });
  }
  return entries;
}
