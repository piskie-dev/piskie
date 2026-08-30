import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachSkillProvenance, defineSkill, z } from '../../../piskiepilot/core/skill/define.js';
import type { BrowserHostRuntime } from '../../../piskiepilot/core/skill/host.js';
import type { GeneratedBrowserSkillRuntime } from '../../../piskiepilot/browser/runtime/generated-skill-browser.js';
import type { ToolContext } from '../../types.js';
import { buildLoadedSkillEntries } from '../domain-descriptors.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('custom Browser Skill call lifecycle', () => {
  it('ends a call that does not settle when the call deadline expires', async () => {
    vi.useFakeTimers();
    const entry = browserEntry(async () => await new Promise<never>(() => {}));
    const execution = entry.tool.execute({}, toolContext(new AbortController().signal));

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    await expect(execution).resolves.toEqual({
      ok: false,
      text: 'Browser Skill call timed out after 600000ms',
    });
  });

  it('propagates a user interruption through the call-scoped signal', async () => {
    const entry = browserEntry(
      async (_params, ctx) =>
        await new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
        })
    );
    const controller = new AbortController();
    const reason = new Error('user interrupted');
    const execution = entry.tool.execute({}, toolContext(controller.signal));

    controller.abort(reason);

    await expect(execution).rejects.toBe(reason);
  });
});

function browserEntry(
  run: (params: Record<string, never>, ctx: { signal: AbortSignal }) => Promise<never>
) {
  const skill = defineSkill({
    name: 'browser-lifecycle-test',
    domain: 'browser',
    functions: {
      run: {
        description: 'Exercise Browser Skill lifecycle',
        params: z.object({}),
        run,
      },
    },
  });
  const [entry] = buildLoadedSkillEntries(
    attachSkillProvenance(skill, {
      root: '/user/skills/browser-lifecycle-test',
      trust: 'custom',
      entryPoint: 'skill_call',
    })
  );
  return entry;
}

function toolContext(signal: AbortSignal): ToolContext {
  const generated = {} as GeneratedBrowserSkillRuntime;
  const browser: BrowserHostRuntime = {
    domain: 'browser',
    core: {} as BrowserHostRuntime['core'],
    notifyPageOpen: vi.fn(),
    createGeneratedRuntime: vi.fn(() => generated),
    prepareScreenshot: vi.fn(),
    finalizeScreenshot: vi.fn(),
    cleanupScreenshot: vi.fn(),
  };
  return {
    agentId: 'agent-1',
    callId: 'call-1',
    workspace: { dir: '/workspace', tempDir: '/tmp/agent-1' },
    signal,
    declareTerminal: vi.fn(),
    post: vi.fn(() => true),
    agentType: 'worker',
    agentSpec: 'browser-worker',
    mainAgentId: 'main-1',
    runConfig: { name: 'Run', description: '', promptTemplate: '' },
    resourceIds: { browserId: 'browser-1' },
    currentModel: 'provider::model',
    modes: { modeId: () => 'normal', approvalMode: () => 'auto' },
    browser,
  };
}
