import { z } from 'zod';

import type { ToolArtifact } from '../../../../shared/types/index.js';
import type { GeneratedBrowserSkillRuntime } from '../../browser/runtime/generated-skill-browser.js';

export { z } from 'zod';

export type ImageRef = Readonly<{
  base64: string;
  mediaType: string;
}>;

export type ToolOutput<TData = undefined> =
  | { ok: true; text: string; images?: ImageRef[]; data?: TData; artifacts?: ToolArtifact[] }
  | { ok: false; text: string; images?: ImageRef[]; data?: TData; artifacts?: ToolArtifact[] };

export function skillToolName(skill: string, functionName: string): string {
  return `${skill}_${functionName}`;
}

export function ok<TData = undefined>(
  text: string,
  extra?: { data?: TData; images?: ImageRef[] },
): ToolOutput<TData> {
  return { ok: true, text, ...extra };
}

export function fail<TData = undefined>(text: string, data?: TData): ToolOutput<TData> {
  return { ok: false, text, data };
}

const coerceNumber = (value: unknown): unknown => {
  if (typeof value !== 'string' || value.trim() === '') return value;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
};

const coerceBoolean = (value: unknown): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

type NumberCheck = Parameters<z.ZodNumber['check']>[number];

export const num = (...checks: NumberCheck[]) => z.preprocess(
  coerceNumber,
  z.number().check(...checks),
);

export const int = (...checks: NumberCheck[]) => z.preprocess(
  coerceNumber,
  z.number().int().check(...checks),
);

export const bool = () => z.preprocess(coerceBoolean, z.boolean());

export type SkillDomain = 'local' | 'browser';

/** The only browser capability visible to generated executable Skills. */
export type BrowserSkillRuntime = GeneratedBrowserSkillRuntime;

export type SkillContextBase = {
  readonly signal: AbortSignal;
  readonly taskId: string;
  readonly executorId: string;
  log(message: string, data?: unknown): void;
};

export type SkillContext<D extends SkillDomain> =
  D extends 'browser'
    ? Pick<SkillContextBase, 'signal' | 'log'> & {
        readonly browser: BrowserSkillRuntime;
      }
    : SkillContextBase;

export type SkillFunction<
  TParams extends z.ZodObject = z.ZodObject,
  D extends SkillDomain = SkillDomain,
  TData = undefined,
  TContext = SkillContext<D>,
> = Readonly<{
  description: string;
  params: TParams;
  run(params: z.infer<TParams>, ctx: TContext): Promise<ToolOutput<TData>>;
}>;

export type SkillFunctions<D extends SkillDomain = SkillDomain> = Record<
  string,
  SkillFunction<z.ZodObject, D, unknown, any>
>;

export type DefinedSkill<
  D extends SkillDomain,
  F extends SkillFunctions<D>,
> = Readonly<{
  name: string;
  domain: D;
  functions: F;
}>;

type FunctionsFromSchemas<
  D extends SkillDomain,
  P extends Record<string, z.ZodObject>,
> = { readonly [K in keyof P]: SkillFunction<P[K], D, unknown> };

/** A Skill module declares only its authoring contract; the host attaches trust separately. */
export function defineSkill<
  const D extends SkillDomain,
  const P extends Record<string, z.ZodObject>,
>(definition: Readonly<{
  name: string;
  domain: D;
  functions: FunctionsFromSchemas<D, P>;
}>): DefinedSkill<D, FunctionsFromSchemas<D, P>> {
  return Object.freeze(definition) as DefinedSkill<D, FunctionsFromSchemas<D, P>>;
}
