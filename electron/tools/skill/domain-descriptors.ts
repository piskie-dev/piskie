import type {
  DomainDescriptor,
  LoadedSkillModule,
  SkillContext,
  SkillDomain,
  SkillFunctions,
} from '../../piskiepilot/core/skill/define.js';
import type { TrustedBrowserSkillContext } from '../../piskiepilot/core/skill/host.js';
import type {
  ITool,
  ToolContext,
  ToolEffect,
  ToolOutput,
  ToolScope,
} from '../types.js';
import { isToolSuspension } from '../types.js';
import { buildSkillEntries } from './register-skill-functions.js';
import { appLog } from '../../observability/logging/app-log.js';

const CUSTOM_BROWSER_SKILL_DEADLINE_MS = 10 * 60_000;

function skillLog(skillName: string, ctx: ToolContext) {
  return (message: string, data?: unknown): void => {
    appLog.info({
      event: 'skill.execution.note',
      message: 'Generated skill execution note',
      context: {
        scope: 'skill.execution',
        skillName,
        agentId: ctx.agentId,
        callId: ctx.callId,
        note: message.slice(0, 500),
        ...(data !== undefined && { notePayload: boundedLogValue(data) }),
      },
    });
  };
}

function boundedLogValue(value: unknown): string {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return (serialized ?? String(value)).slice(0, 1_000);
  } catch {
    return String(value).slice(0, 1_000);
  }
}

function localContext(skillName: string, ctx: ToolContext) {
  return {
    signal: ctx.signal,
    taskId: ctx.agentId,
    executorId: ctx.agentId,
    log: skillLog(skillName, ctx),
  };
}

function wrapBrowserScreenshot(
  base: ITool<Record<string, unknown>, unknown>,
): ITool<Record<string, unknown>, unknown> {
  return {
    def: base.def,
    prepare: base.prepare?.bind(base),
    async execute(params, ctx): Promise<ToolOutput<unknown>> {
      if (!ctx.browser) throw new Error('Browser runtime is unavailable');
      const target = await ctx.browser.prepareScreenshot(params);
      try {
        const output = await base.execute(params, ctx);
        if (isToolSuspension(output)) {
          await ctx.browser.cleanupScreenshot(target);
          throw new Error('Browser screenshot cannot suspend');
        }
        if (output.ok) await ctx.browser.finalizeScreenshot(target);
        else await ctx.browser.cleanupScreenshot(target);
        return output;
      } catch (error) {
        await ctx.browser.cleanupScreenshot(target);
        throw error;
      }
    },
  };
}

function wrapCustomBrowserCall<TParams>(base: ITool<TParams, unknown>): ITool<TParams, unknown> {
  return {
    def: base.def,
    prepare: base.prepare?.bind(base),
    async execute(params, ctx) {
      ctx.signal.throwIfAborted();
      const deadline = new AbortController();
      const timeoutMessage = `Browser Skill call timed out after ${CUSTOM_BROWSER_SKILL_DEADLINE_MS}ms`;
      const timer = setTimeout(() => {
        const error = new Error(timeoutMessage);
        error.name = 'BrowserSkillTimeoutError';
        deadline.abort(error);
      }, CUSTOM_BROWSER_SKILL_DEADLINE_MS);
      timer.unref?.();

      const signal = AbortSignal.any([ctx.signal, deadline.signal]);
      let onAbort: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('Browser Skill call was cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const execution = base.execute(params, { ...ctx, signal });

      try {
        return await Promise.race([execution, cancelled]);
      } catch (error) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? error;
        if (deadline.signal.aborted) return { ok: false, text: timeoutMessage };
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort!);
      }
    },
  };
}

type DescriptorAccess = Readonly<{
  domain: SkillDomain;
  scope: ToolScope;
  effects: readonly ToolEffect[];
}>;

const BUILTIN_ACCESS: Readonly<Record<string, DescriptorAccess>> = Object.freeze({
  browser: { domain: 'browser', scope: 'shared', effects: ['read-fs', 'write-fs'] },
});

const CUSTOM_ACCESS: Readonly<Record<SkillDomain, DescriptorAccess>> = Object.freeze({
  local: { domain: 'local', scope: 'shared', effects: ['read-fs', 'write-fs', 'exec'] },
  browser: { domain: 'browser', scope: 'shared', effects: ['read-fs', 'write-fs', 'exec'] },
});

function accessFor(skill: LoadedSkillModule<SkillDomain, SkillFunctions>): DescriptorAccess {
  if (skill.provenance.trust === 'builtin') {
    if (skill.provenance.entryPoint !== 'direct') {
      throw new Error(`Built-in Skill ${skill.name} must come from a direct loader root`);
    }
    const access = BUILTIN_ACCESS[skill.name];
    if (!access) throw new Error(`Missing trusted DomainDescriptor for built-in Skill ${skill.name}`);
    if (access.domain !== skill.domain) {
      throw new Error(
        `Trusted DomainDescriptor for ${skill.name} expects ${access.domain}, received ${skill.domain}`,
      );
    }
    return access;
  }
  if (skill.provenance.entryPoint !== 'skill_call') {
    throw new Error(`Custom Skill ${skill.name} must come from a skill_call loader root`);
  }
  return CUSTOM_ACCESS[skill.domain];
}

export function descriptorFor<
  D extends SkillDomain,
  F extends SkillFunctions<D>,
>(skill: LoadedSkillModule<D, F>): DomainDescriptor<D, F> {
  const access = accessFor(skill as LoadedSkillModule<SkillDomain, SkillFunctions>);
  const common = {
    scope: access.scope,
    effects: access.effects,
  };
  if (skill.domain === 'browser') {
    const trusted = skill.provenance.trust === 'builtin';
    const wrapExecute = trusted
      ? { takeScreenshot: wrapBrowserScreenshot }
      : Object.fromEntries(
          Object.keys(skill.functions).map((functionName) => [functionName, wrapCustomBrowserCall])
        );
    return {
      ...common,
      domain: 'browser',
      makeContext(ctx: ToolContext): SkillContext<'browser'> | TrustedBrowserSkillContext {
        const browserId = ctx.resourceIds.browserId;
        if (!browserId || !ctx.browser) throw new Error('Incomplete browser SkillContext');
        const log = skillLog(skill.name, ctx);
        if (trusted) {
          return {
            signal: ctx.signal,
            log,
            browserId,
            browser: ctx.browser,
            workspace: ctx.workspace,
          };
        }
        return {
          signal: ctx.signal,
          log,
          browser: ctx.browser.createGeneratedRuntime({
            browserId,
            signal: ctx.signal,
            log,
            notifyPageOpen: () => ctx.browser?.notifyPageOpen(),
          }),
        };
      },
      wrapExecute,
    } as DomainDescriptor<D, F>;
  }
  return {
    ...common,
    domain: 'local',
    makeContext(ctx: ToolContext): SkillContext<'local'> {
      return localContext(skill.name, ctx);
    },
  } as DomainDescriptor<D, F>;
}

export function buildLoadedSkillEntries(
  skill: LoadedSkillModule<SkillDomain, SkillFunctions>,
) {
  return buildSkillEntries(skill, descriptorFor(skill));
}
