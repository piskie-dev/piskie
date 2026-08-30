import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
}));

import browserCore from '../../../piskiepilot/browser/skills/browser/skill.js';
import { attachSkillProvenance } from '../../../piskiepilot/core/skill/define.js';
import { toApiSchema } from '../../params.js';
import type { ToolContext } from '../../types.js';
import { buildLoadedSkillEntries } from '../domain-descriptors.js';

describe('browser screenshot model/host boundary', () => {
  it('hides filePath from the model, injects it in the host, and preserves result text', async () => {
    const loaded = attachSkillProvenance(browserCore, {
      root: '/app/skills/browser',
      trust: 'builtin',
      entryPoint: 'direct',
    });
    const entry = buildLoadedSkillEntries(loaded)
      .find((candidate) => candidate.identity.function === 'takeScreenshot');
    if (!entry) throw new Error('takeScreenshot tool missing');

    const schema = toApiSchema(entry.tool.def.schema);
    expect(schema.properties).not.toHaveProperty('filePath');

    const finalPath = '/user-data/agent-runs/main-1/workers/worker-1/screenshots/final.png';
    const prepareScreenshot = vi.fn(async (params: Record<string, unknown>) => {
      params.filePath = finalPath;
      return {
        id: 'shot-1',
        mainAgentId: 'main-1',
        agentId: 'worker-1',
        filename: 'final.png',
        filePath: finalPath,
        timestamp: new Date('2026-08-19T00:00:00.000Z'),
        size: 0,
        format: 'png' as const,
      };
    });
    const takeScreenshot = vi.fn(async () => `Saved screenshot to ${finalPath}.`);
    const finalizeScreenshot = vi.fn(async () => undefined);
    const output = await entry.tool.execute({ format: 'png' }, {
      agentType: 'worker',
      agentSpec: 'browser-worker',
      agentId: 'worker-1',
      mainAgentId: 'main-1',
      runConfig: { name: 'Run', description: '', promptTemplate: '' },
      resourceIds: { browserId: 'browser-1' },
      signal: new AbortController().signal,
      log: vi.fn(),
      browser: {
        core: { takeScreenshot },
        prepareScreenshot,
        finalizeScreenshot,
        cleanupScreenshot: vi.fn(async () => undefined),
      },
    } as unknown as ToolContext);

    expect(prepareScreenshot).toHaveBeenCalledWith({ format: 'png', filePath: finalPath });
    expect(takeScreenshot).toHaveBeenCalledWith({
      format: 'png',
      filePath: finalPath,
      browserId: 'browser-1',
    });
    expect(finalizeScreenshot).toHaveBeenCalledOnce();
    expect(output).toEqual({ ok: true, text: `Saved screenshot to ${finalPath}.` });
  });
});
