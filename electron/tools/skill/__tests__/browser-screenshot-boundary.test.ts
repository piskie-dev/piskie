import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
}));

import browserCore from '../../../piskiepilot/browser/skills/browser/skill.js';
import { attachSkillProvenance } from '../../../piskiepilot/core/skill/define.js';
import { toApiSchema } from '../../params.js';
import type { ToolContext } from '../../types.js';
import { buildLoadedSkillEntries } from '../domain-descriptors.js';

function screenshotEntry() {
  const loaded = attachSkillProvenance(browserCore, {
    root: '/app/skills/browser', trust: 'builtin', entryPoint: 'direct',
  });
  const entry = buildLoadedSkillEntries(loaded)
    .find((candidate) => candidate.identity.function === 'take_screenshot');
  if (!entry) throw new Error('take_screenshot tool missing');
  return entry;
}

function context(take_screenshot: ReturnType<typeof vi.fn>): ToolContext {
  return {
    agentId: 'worker-1', mainAgentId: 'main-1', resourceIds: { browserId: 'browser-1' },
    signal: new AbortController().signal,
    workspace: { dir: '/workspace', tempDir: '/workspace/tmp' },
    browser: { core: { take_screenshot } },
  } as unknown as ToolContext;
}

describe('browser screenshot model/host boundary', () => {
  it('exposes the source filePath contract and carries inline image bytes and MIME unchanged', async () => {
    const entry = screenshotEntry();
    expect(toApiSchema(entry.tool.def.schema).properties).toHaveProperty('filePath');
    const take_screenshot = vi.fn(async () => ({
      text: "Took a screenshot of the current page's viewport.",
      image: { data: 'c2FtcGxlLWltYWdl', mimeType: 'image/webp' },
    }));
    const ctx = context(take_screenshot);
    const params = { pageId: 7, format: 'webp' };
    const output = await entry.tool.execute(params, ctx);

    expect(params).toEqual({ pageId: 7, format: 'webp' });
    expect(take_screenshot).toHaveBeenCalledExactlyOnceWith({
      pageId: 7, format: 'webp', browserId: 'browser-1', signal: ctx.signal,
      files: { cwd: '/workspace', tempDir: '/workspace/tmp', allowedRoots: ['/workspace', '/workspace/tmp'] },
    });
    expect(output).toEqual({
      ok: true, text: "Took a screenshot of the current page's viewport.",
      images: [{ base64: 'c2FtcGxlLWltYWdl', mediaType: 'image/webp' }],
    });
  });

  it.each(['explicit', 'temporary'])('preserves %s file results without substituting a host screenshot path', async (kind) => {
    const entry = screenshotEntry();
    const finalPath = kind === 'explicit' ? '/workspace/export.png' : '/workspace/tmp/observation/screenshot.png';
    const take_screenshot = vi.fn(async (_params: Record<string, unknown>) => ({ text: `Saved screenshot to ${finalPath}.`, filePath: finalPath }));
    const params = { pageId: 7, format: 'png', ...(kind === 'explicit' ? { filePath: '/workspace/export.png' } : {}) };
    const output = await entry.tool.execute(params, context(take_screenshot));
    expect(take_screenshot.mock.calls[0][0]).toMatchObject(params);
    expect(output).toEqual({ ok: true, text: `Saved screenshot to ${finalPath}.` });
  });

  it('propagates screenshot failure through the existing error channel', async () => {
    const failure = new Error('Could not save observation');
    const take_screenshot = vi.fn(async () => { throw failure; });
    await expect(screenshotEntry().tool.execute({ pageId: 7, format: 'png', filePath: '/workspace/export.png' }, context(take_screenshot)))
      .rejects.toBe(failure);
    expect(take_screenshot).toHaveBeenCalledOnce();
  });
});
