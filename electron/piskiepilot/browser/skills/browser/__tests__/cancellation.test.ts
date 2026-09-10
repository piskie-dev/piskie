import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrustedBrowserSkillContext } from '../../../../core/skill/host.js';

const boundary = vi.hoisted(() => ({
  runExclusive: vi.fn(async (_id: string, _operation: unknown, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    throw new Error('Operation reached the browser without cancellation');
  }),
  close: vi.fn(async (_id: string) => {}),
}));
vi.mock('../../../core/browser/browser-manager.js', () => ({ BrowserManager: boundary }));

import skill from '../skill.js';
import * as core from '../index.js';

const inputs = {
  takeSnapshot: {},
  clickByUid: { uid: '1_1' },
  fillByUid: { uid: '1_1', value: 'example' },
  pressKey: { key: 'Enter' },
  navigateTo: { url: 'https://example.test' },
  goBack: {},
  refresh: {},
  newPage: { url: 'https://example.test' },
  closePage: { pageIndex: 0 },
  listPages: {},
  selectPage: { pageIdx: 0 },
  handleDialog: { action: 'dismiss' },
  waitFor: { text: ['Ready'] },
  hoverByUid: { uid: '1_1' },
  drag: { fromUid: '1_1', toUid: '1_2' },
  uploadFile: { uid: '1_1', filePath: '/workspace/input.txt' },
  fillFormByUids: { elements: [{ uid: '1_1', value: 'example' }] },
  takeScreenshot: {},
  evaluateScript: { function: '() => 1' },
  listConsoleMessages: {},
  getConsoleMessage: { msgid: 1 },
  listNetworkRequests: {},
  getNetworkRequest: { reqid: 1 },
  getAllCookies: {},
  setCookies: { cookies: [] },
  deleteCookies: { cookies: [] },
  clearCookies: {},
  getWindowBounds: {},
  setWindowBounds: { bounds: { width: 800 } },
} satisfies Record<Exclude<keyof typeof skill.functions, 'closeBrowser'>, unknown>;

function context(signal: AbortSignal): TrustedBrowserSkillContext {
  return {
    browserId: 'browser-a', signal, log: vi.fn(),
    workspace: { dir: '/workspace', tempDir: '/workspace/tmp' },
    browser: { core, notifyPageOpen: vi.fn() } as unknown as TrustedBrowserSkillContext['browser'],
  };
}

beforeEach(() => vi.clearAllMocks());

describe('built-in browser cancellation', () => {
  it.each(Object.entries(inputs))('%s reaches the shared cancellation boundary', async (name, input) => {
    const controller = new AbortController();
    const reason = new Error('Task stopped');
    controller.abort(reason);
    const definition = skill.functions[name as keyof typeof inputs];
    const params = definition.params.parse(input);
    const run = definition.run as (params: unknown, ctx: TrustedBrowserSkillContext) => Promise<unknown>;

    await expect(run(params, context(controller.signal))).rejects.toBe(reason);
    expect(boundary.runExclusive).toHaveBeenCalledOnce();
    expect(boundary.runExclusive).toHaveBeenCalledWith('browser-a', expect.any(Function), controller.signal);
  });

  it('finishes browser closure even when the caller is cancelled', async () => {
    let finishClose!: () => void;
    boundary.close.mockImplementationOnce(() => new Promise((resolve) => { finishClose = resolve; }));
    const controller = new AbortController();
    controller.abort();
    let completed = false;
    const closing = skill.functions.closeBrowser.run({}, context(controller.signal))
      .then((output) => { completed = true; return output; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(boundary.close).toHaveBeenCalledWith('browser-a');
    expect(boundary.runExclusive).not.toHaveBeenCalled();
    finishClose();
    await expect(closing).resolves.toMatchObject({ ok: true });
  });
});
