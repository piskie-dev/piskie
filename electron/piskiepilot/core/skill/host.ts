import type { z } from 'zod';

import type {
  DefinedSkill,
  SkillContextBase,
  SkillFunction,
} from './define.js';
import type {
  GeneratedBrowserSkillRuntime,
  GeneratedSkillBrowserBinding,
} from '../../browser/runtime/generated-skill-browser.js';

export type BrowserScreenshotTarget = {
  id: string;
  mainAgentId: string;
  agentId: string;
  filename: string;
  filePath: string;
  timestamp: Date;
  size: number;
  format: 'png' | 'jpeg' | 'webp';
};

/** Trusted host capability. This module is deliberately absent from the external Skill shim. */
export interface BrowserHostRuntime {
  readonly domain: 'browser';
  readonly core: typeof import('../../browser/skills/browser/index.js');
  notifyPageOpen(): void;
  createGeneratedRuntime(binding: GeneratedSkillBrowserBinding): GeneratedBrowserSkillRuntime;
  prepareScreenshot(params: Record<string, unknown>): Promise<BrowserScreenshotTarget>;
  finalizeScreenshot(target: BrowserScreenshotTarget): Promise<void>;
  cleanupScreenshot(target: BrowserScreenshotTarget): Promise<void>;
}

export type TrustedBrowserSkillContext = Pick<SkillContextBase, 'signal' | 'log'> & {
  readonly browserId: string;
  readonly browser: BrowserHostRuntime;
  readonly workspace: Readonly<{ dir: string; tempDir: string }>;
};

type TrustedFunctionsFromSchemas<P extends Record<string, z.ZodObject>> = {
  readonly [K in keyof P]: SkillFunction<P[K], 'browser', unknown, TrustedBrowserSkillContext>;
};

/** Define a bundled browser Skill that needs trusted host modules. Never export this through core-skill. */
export function defineTrustedBrowserSkill<const P extends Record<string, z.ZodObject>>(
  definition: Readonly<{
    name: string;
    domain: 'browser';
    functions: TrustedFunctionsFromSchemas<P>;
  }>,
): DefinedSkill<'browser', TrustedFunctionsFromSchemas<P>> {
  return Object.freeze(definition) as DefinedSkill<'browser', TrustedFunctionsFromSchemas<P>>;
}
