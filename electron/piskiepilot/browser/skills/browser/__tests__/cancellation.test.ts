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
  list_pages: {},
  new_page: { url: 'https://example.test' },
  select_page: { pageId: 7 },
  close_page: { pageId: 7 },
  navigate_page: { pageId: 7, url: 'https://example.test' },
  take_snapshot: { pageId: 7 },
  click: { pageId: 7, uid: '1_1' },
  hover: { pageId: 7, uid: '1_1' },
  fill: { pageId: 7, uid: '1_1', value: 'Sample value' },
  fill_form: { pageId: 7, elements: [{ uid: '1_1', value: 'Sample value' }] },
  type_text: { pageId: 7, text: 'Example 中文😀\n', submitKey: 'Enter' },
  press_key: { pageId: 7, key: 'Enter' },
  drag: { pageId: 7, from_uid: '1_1', to_uid: '1_2' },
  upload_file: { pageId: 7, uid: '1_1', filePaths: ['/workspace/input.txt'] },
  wait_for: { pageId: 7, text: ['Ready'] },
  handle_dialog: { pageId: 7, action: 'dismiss' },
  take_screenshot: { pageId: 7 },
  evaluate_script: { pageId: 7, function: '() => 1' },
  list_console_messages: { pageId: 7 },
  get_console_message: { pageId: 7, msgid: 1 },
  list_network_requests: { pageId: 7 },
  get_network_request: { pageId: 7, reqid: 1 },
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
    const run = definition.run as (params: unknown, ctx: TrustedBrowserSkillContext) => Promise<unknown>;

    await expect(run(definition.params.parse(input), context(controller.signal))).rejects.toBe(reason);
    expect(boundary.runExclusive).toHaveBeenCalledOnce();
    expect(boundary.runExclusive.mock.calls[0].slice(0, 3)).toEqual(['browser-a', expect.any(Function), controller.signal]);
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
