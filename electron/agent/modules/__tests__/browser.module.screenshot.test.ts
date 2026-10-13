import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => '/tmp' } }));
const mocks = vi.hoisted(() => {
  const page = { screenshot: vi.fn(async () => Buffer.from('sample-image')) };
  const automation = { getPage: vi.fn(() => page), getDialog: vi.fn(() => undefined), throwIfDialogOpen: vi.fn() };
  return { page, automation, runExclusive: vi.fn(async (_id: string, action: (session: unknown) => unknown) => action({ automation })) };
});
vi.mock('../../../piskiepilot/browser/core/browser/browser-manager.js', () => ({ BrowserManager: { runExclusive: mocks.runExclusive } }));

import type { AgentHost } from '../../agent-host.js';
import { BrowserModule } from '../browser.module.js';
import skill from '../../../piskiepilot/browser/skills/browser/skill.js';
import { attachSkillProvenance } from '../../../piskiepilot/core/skill/define.js';
import { buildLoadedSkillEntries } from '../../../tools/skill/domain-descriptors.js';
import type { ToolContext } from '../../../tools/types.js';

let root = '';
let workspace = '';
let tempDir = '';
beforeEach(() => {
  const testRoot = process.env.PISKIE_TEST_TEMP_DIR ?? os.tmpdir();
  fs.mkdirSync(testRoot, { recursive: true });
  root = fs.mkdtempSync(path.join(testRoot, 'screenshot-adapter-'));
  workspace = path.join(root, 'workspace'); tempDir = path.join(root, 'temporary');
  fs.mkdirSync(workspace); fs.mkdirSync(tempDir);
  vi.clearAllMocks();
  mocks.page.screenshot.mockResolvedValue(Buffer.from('sample-image'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function call(params: Record<string, unknown>) {
  const module = new BrowserModule();
  module.init({ id: 'worker-a', mainAgentId: 'main-a' } as AgentHost, {});
  const entry = buildLoadedSkillEntries(attachSkillProvenance(skill, {
    root: '/builtin/browser', trust: 'builtin', entryPoint: 'direct',
  })).find(candidate => candidate.identity.function === 'take_screenshot')!;
  return entry.tool.execute({ pageId: 7, format: 'png', ...params }, {
    browser: module, resourceIds: { browserId: 'browser-a' }, signal: new AbortController().signal,
    workspace: { dir: workspace, tempDir },
  } as ToolContext);
}

describe('BrowserModule screenshot result adaptation', () => {
  it('carries viewport image bytes without imposing a screenshot file path', async () => {
    await expect(call({})).resolves.toEqual({
      ok: true, text: "Took a screenshot of the current page's viewport.",
      images: [{ base64: Buffer.from('sample-image').toString('base64'), mediaType: 'image/png' }],
    });
    expect(fs.readdirSync(workspace)).toEqual([]);
    expect(fs.readdirSync(tempDir)).toEqual([]);
    expect(mocks.automation.getPage).toHaveBeenCalledExactlyOnceWith(7);
    expect(mocks.runExclusive).toHaveBeenCalledWith('browser-a', expect.any(Function), expect.any(AbortSignal), { pageId: 7, feedback: false });
  });

  it('saves the caller-selected file with the source format extension and reports the actual path', async () => {
    const filepath = path.join(workspace, 'capture.webp');
    await expect(call({ format: 'webp', filePath: 'capture.data' })).resolves.toEqual({
      ok: true, text: `Took a screenshot of the current page's viewport.\nSaved screenshot to ${filepath}.`,
    });
    expect(fs.readFileSync(filepath)).toEqual(Buffer.from('sample-image'));
    expect(mocks.page.screenshot).toHaveBeenCalledExactlyOnceWith({ type: 'webp', quality: undefined, fullPage: false, optimizeForSpeed: true });
  });

  it('stores images at the source large-image threshold in the task temporary directory', async () => {
    const bytes = Buffer.alloc(2_000_000, 1);
    mocks.page.screenshot.mockResolvedValueOnce(bytes);
    const output = await call({});
    const filepath = output.text.split('Saved screenshot to ')[1].slice(0, -1);
    expect(filepath.startsWith(tempDir + path.sep)).toBe(true);
    expect(fs.readFileSync(filepath)).toEqual(bytes);
    expect(output).not.toHaveProperty('images');
  });

  it('validates the output path before capture and preserves existing caller files on capture failure', async () => {
    await expect(call({ filePath: path.join(root, 'outside.png') })).rejects.toThrow();
    expect(mocks.page.screenshot).not.toHaveBeenCalled();
    const filepath = path.join(workspace, 'existing.png');
    fs.writeFileSync(filepath, 'previous file');
    const error = new Error('Sample capture failure');
    mocks.page.screenshot.mockRejectedValueOnce(error);
    await expect(call({ filePath: filepath })).rejects.toBe(error);
    expect(fs.readFileSync(filepath, 'utf8')).toBe('previous file');
  });
});
