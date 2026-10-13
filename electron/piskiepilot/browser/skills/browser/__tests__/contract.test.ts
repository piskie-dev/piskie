import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionReceipt } from '../../../core/session/action-waiter.js';

const mocks = vi.hoisted(() => {
  const receipt: ActionReceipt = { navigated: false, domSettled: true, openedPageIds: [], closedPageIds: [] };
  const child = { id: '7_1', role: 'button', name: 'Continue', children: [] };
  const root = { id: '7_0', role: 'textbox', name: 'Field A', value: 'Sample value', children: [child] };
  const snapshot = { snapshotId: '7', root, idToNode: new Map([['7_0', root], ['7_1', child]]), verbose: false };
  const functionHandle = { dispose: vi.fn(async () => undefined) };
  const page = {
    url: vi.fn(() => 'https://example.test/target'), title: vi.fn(async () => 'Sample page'),
    screenshot: vi.fn(async () => Buffer.from('page-image')),
    evaluateHandle: vi.fn(async () => functionHandle),
    evaluate: vi.fn(async () => JSON.stringify({ ready: true })),
  };
  const element = { frame: page, screenshot: vi.fn(async () => Buffer.from('element-image')), dispose: vi.fn(async () => undefined) };
  const consoleCollector = {};
  const networkCollector = {};
  const serviceWorkers = {};
  const automation = {
    takeSnapshot: vi.fn(async () => snapshot),
    clickByUid: vi.fn(async () => receipt), fillByUid: vi.fn(async () => receipt),
    hoverByUid: vi.fn(async () => receipt), fillFormByUids: vi.fn(async () => receipt),
    dragByUids: vi.fn(async () => receipt), typeText: vi.fn(async () => receipt),
    pressKey: vi.fn(async () => receipt), uploadFileByUid: vi.fn(async () => undefined),
    handleDialog: vi.fn(async () => undefined), waitForTextOnPage: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page), closePageById: vi.fn(async () => undefined),
    selectPageById: vi.fn(async () => page),
    listPages: vi.fn(async () => [{ pageId: 7, page, navigationSequence: 0, isolatedContextName: 'sample-context' }]),
    getSelectedPageId: vi.fn(() => 3),
    consumeSelectedPageFallback: vi.fn<() => { wasClosed: boolean } | undefined>(() => undefined),
    getPage: vi.fn(() => page), getPageById: vi.fn(() => page), getElementByUid: vi.fn(async () => element),
    getActiveSnapshot: vi.fn(() => snapshot),
    getDialog: vi.fn<() => undefined | { type(): string; message(): string; defaultValue(): string }>(() => undefined),
    throwIfDialogOpen: vi.fn(),
    waitForAction: vi.fn(async (action: (signal: AbortSignal) => Promise<unknown>) => {
      await action(new AbortController().signal); return receipt;
    }),
    getConsoleCollector: vi.fn(() => consoleCollector), getNetworkCollector: vi.fn(() => networkCollector),
    getServiceWorkerConsoleCollector: vi.fn(() => serviceWorkers),
  };
  const runExclusive = vi.fn(async (_browserId: string, action: (session: { automation: typeof automation }) => unknown) => action({ automation }));
  const operations = {
    navigateInSession: vi.fn(async () => ({
      type: 'url', url: 'https://example.test/target', title: 'Sample page', receipt,
      message: 'Successfully navigated to https://example.test/target.',
    })),
    close: vi.fn(async () => undefined),
    getAllCookies: vi.fn(async () => ({ success: true, count: 1, cookies: [{ name: 'sample', value: 'example' }] })),
    setCookies: vi.fn(async () => ({ success: true, count: 1 })),
    deleteCookies: vi.fn(async () => ({ success: true, count: 1 })),
    clearCookies: vi.fn(async () => ({ success: true })),
    getWindowBounds: vi.fn(async () => ({ left: 1, top: 2, width: 800, height: 600 })),
    setWindowBounds: vi.fn(async () => ({ left: 10, top: 20, width: 900, height: 700 })),
  };
  const data = {
    listConsoleMessages: vi.fn(async () => ({ text: '## Console messages\nmsgid=11 [log] Sample message' })),
    getConsoleMessage: vi.fn(async () => ({ text: 'ID: 11\nMessage: log> Sample message' })),
    listNetworkRequests: vi.fn(async () => ({ text: '## Network requests\nreqid=21 GET https://example.test/api [success - 200]' })),
    getNetworkRequest: vi.fn(async () => ({ text: '## Request https://example.test/api\nStatus: 200' })),
    resolveCdpRequestId: vi.fn(() => 21),
  };
  const files = {
    validateObservationFile: vi.fn(async (_name: string, extension: string) => `/workspace/output${extension}`),
    saveObservationFile: vi.fn(async (_bytes: Uint8Array, _name: string, extension: string) => ({ filename: `/workspace/output${extension}` })),
    saveTemporaryObservationFile: vi.fn(async () => ({ filepath: '/workspace/tmp/screenshot.png' })),
  };
  return { automation, receipt, snapshot, page, element, functionHandle, operations, runExclusive,
    data, files, consoleCollector, networkCollector, serviceWorkers, validatePathWithinRoots: vi.fn(async () => undefined) };
});

vi.mock('../../../core/browser/browser-manager.js', () => ({ BrowserManager: { runExclusive: mocks.runExclusive } }));
vi.mock('../../../core/browser/browser-operations.js', () => ({ BrowserOperations: mocks.operations }));
vi.mock('../../../core/session/file-roots.js', () => ({ validatePathWithinRoots: mocks.validatePathWithinRoots }));
vi.mock('../../../core/session/observation-files.js', () => mocks.files);
vi.mock('../../../core/session/page-data.js', () => mocks.data);

import skill from '../skill.js';
import * as core from '../index.js';

const ctx = { browserId: 'browser-a', pageId: 7 };
const files = { cwd: '/workspace', tempDir: '/workspace/tmp', allowedRoots: ['/workspace', '/workspace/tmp'] };
const snapshotText = 'uid=7_0 textbox "Field A" value="Sample value"\n  uid=7_1 button "Continue"\n';
const embeddedSnapshot = `## Latest page snapshot\n${snapshotText}`;
const pagesText = '## Pages\n7: Sample page (https://example.test/target) isolatedContext=sample-context';
const dialog = { type: () => 'prompt', message: () => 'Sample prompt', defaultValue: () => 'Sample response' };
const dialogText = '# Open dialog\nprompt: Sample prompt (default value: "Sample response").\nCall handle_dialog to handle it before continuing.';
const inputs = {
  click: { uid: '7_1' }, hover: { uid: '7_1' }, fill: { uid: '7_0', value: 'Next value' },
  fill_form: { elements: [{ uid: '7_0', value: 'Next value' }] },
  drag: { from_uid: '7_0', to_uid: '7_1' },
  upload_file: { uid: '7_0', filePaths: ['/workspace/a.txt', '/workspace/b.txt'], allowedRoots: files.allowedRoots },
  press_key: { key: 'Enter' },
};
type InputName = keyof typeof inputs;
function input(name: InputName, includeSnapshot?: boolean): Promise<string> {
  const run = core[name] as (params: Record<string, unknown>) => Promise<string>;
  return run({ ...ctx, ...inputs[name], ...(includeSnapshot === undefined ? {} : { includeSnapshot }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.automation.getDialog.mockReturnValue(undefined);
  mocks.automation.throwIfDialogOpen.mockReset();
  mocks.automation.takeSnapshot.mockResolvedValue(mocks.snapshot as never);
  mocks.automation.closePageById.mockResolvedValue(undefined);
  mocks.automation.consumeSelectedPageFallback.mockReturnValue(undefined);
  mocks.automation.getSelectedPageId.mockReturnValue(3);
  mocks.page.screenshot.mockResolvedValue(Buffer.from('page-image'));
  for (const action of ['clickByUid', 'hoverByUid', 'fillByUid', 'fillFormByUids', 'dragByUids', 'pressKey', 'typeText'] as const) {
    mocks.automation[action].mockResolvedValue(mocks.receipt);
  }
  mocks.operations.navigateInSession.mockResolvedValue({
    type: 'url', url: 'https://example.test/target', title: 'Sample page', receipt: mocks.receipt,
    message: 'Successfully navigated to https://example.test/target.',
  });
});

describe('browser tool handler contract', () => {
  it.each(Object.keys(inputs) as InputName[])('%s does not collect AX when includeSnapshot is omitted or false', async (name) => {
    for (const includeSnapshot of [undefined, false]) {
      await expect(input(name, includeSnapshot)).resolves.not.toContain('snapshot');
    }
    expect(mocks.automation.takeSnapshot).not.toHaveBeenCalled();
    expect(mocks.automation.selectPageById).not.toHaveBeenCalled();
    expect(mocks.automation.getSelectedPageId).not.toHaveBeenCalled();
    expect(mocks.runExclusive).toHaveBeenCalledWith('browser-a', expect.any(Function), undefined, { pageId: 7, feedback: true });
  });

  it.each(Object.keys(inputs) as InputName[])('%s requests exactly one latest target-page snapshot on normal true success', async (name) => {
    await expect(input(name, true)).resolves.toContain(embeddedSnapshot);
    expect(mocks.automation.takeSnapshot).toHaveBeenCalledExactlyOnceWith(false, 7);
  });

  it('passes source input fields and stable target IDs to the shared session', async () => {
    await core.click({ ...ctx, uid: '7_1', dblClick: true });
    await input('hover'); await input('fill'); await input('fill_form'); await input('drag'); await input('upload_file'); await input('press_key');
    expect(mocks.automation.clickByUid).toHaveBeenCalledExactlyOnceWith('7_1', 2, 7);
    expect(mocks.automation.hoverByUid).toHaveBeenCalledExactlyOnceWith('7_1', 7);
    expect(mocks.automation.fillByUid).toHaveBeenCalledExactlyOnceWith('7_0', 'Next value', 7);
    expect(mocks.automation.fillFormByUids).toHaveBeenCalledExactlyOnceWith(inputs.fill_form.elements, 7);
    expect(mocks.automation.dragByUids).toHaveBeenCalledExactlyOnceWith('7_0', '7_1', 7);
    expect(mocks.automation.uploadFileByUid).toHaveBeenCalledExactlyOnceWith('7_0', inputs.upload_file.filePaths, 7);
    expect(mocks.validatePathWithinRoots).toHaveBeenCalledWith('/workspace/a.txt', files.allowedRoots);
    expect(mocks.validatePathWithinRoots).toHaveBeenCalledWith('/workspace/b.txt', files.allowedRoots);
    expect(mocks.automation.pressKey).toHaveBeenCalledExactlyOnceWith('Enter', 7);
    expect(mocks.automation.waitForAction).not.toHaveBeenCalled();
  });

  it.each(['Sample text', '  中文😀\nNext paragraph  ', ''])('type_text preserves %j and submitKey without AX', async (text) => {
    await expect(core.type_text({ ...ctx, text, submitKey: 'Enter' })).resolves.toBe(`Typed text "${text} + Enter"`);
    expect(mocks.automation.typeText).toHaveBeenCalledExactlyOnceWith(text, 'Enter', 7);
    expect(mocks.automation.takeSnapshot).not.toHaveBeenCalled();
  });

  it('appends source URL feedback without exposing action receipt fields', async () => {
    mocks.automation.clickByUid.mockResolvedValueOnce({ ...mocks.receipt, navigated: true, navigatedToUrl: 'https://example.test/next' });
    await expect(input('click')).resolves.toBe('Successfully clicked on the element\nPage navigated to https://example.test/next.');
  });

  it.each([
    ['click', 'The element was clicked and it opened a dialog.', 'clickByUid'],
    ['hover', 'The element was hovered and it opened a dialog.', 'hoverByUid'],
    ['fill', 'The element was filled out and it opened a dialog.', 'fillByUid'],
  ] as const)('%s uses its recognized dialog branch even when snapshot=true', async (name, message, action) => {
    mocks.automation[action].mockResolvedValueOnce({ ...mocks.receipt, interrupted: true });
    mocks.automation.getDialog.mockReturnValue(dialog);
    await expect(input(name, true)).resolves.toBe(`${message}\n${dialogText}`);
    expect(mocks.automation.takeSnapshot).not.toHaveBeenCalled();
  });

  it.each([['7_0', true], ['7_1', false]] as const)('fill_form reports interrupted UID %s and only source remaining-elements text', async (interruptedUid, remaining) => {
    mocks.automation.fillFormByUids.mockResolvedValueOnce({ ...mocks.receipt, interrupted: true, interruptedUid });
    mocks.automation.getDialog.mockReturnValue(dialog);
    await expect(core.fill_form({ ...ctx, elements: [{ uid: '7_0', value: 'A' }, { uid: '7_1', value: 'B' }], includeSnapshot: true }))
      .resolves.toBe(`Filling out the element with uid ${interruptedUid} opened a dialog.${remaining ? ' The remaining elements were not filled out.' : ''}\n${dialogText}`);
    expect(mocks.automation.takeSnapshot).not.toHaveBeenCalled();
  });

  it('does not apply the click/fill early-return branch to press_key with an open response dialog', async () => {
    mocks.automation.getDialog.mockReturnValue(dialog);
    await expect(input('press_key', true)).resolves.toBe(`Successfully pressed key: Enter\n${dialogText}\n${embeddedSnapshot}`);
    expect(mocks.automation.takeSnapshot).toHaveBeenCalledExactlyOnceWith(false, 7);
  });

  it('propagates action and post-action snapshot errors without replaying input', async () => {
    const actionFailure = new Error('Failed to interact with the element with uid 7_1. Sample failure');
    mocks.automation.clickByUid.mockRejectedValueOnce(actionFailure);
    await expect(input('click', true)).rejects.toBe(actionFailure);
    expect(mocks.automation.takeSnapshot).not.toHaveBeenCalled();
    mocks.automation.takeSnapshot.mockRejectedValueOnce(new Error('Failed to create accessibility snapshot'));
    await expect(input('click', true)).rejects.toThrow('Failed to create accessibility snapshot');
    expect(mocks.automation.clickByUid).toHaveBeenCalledTimes(2);
    expect(mocks.automation.takeSnapshot).toHaveBeenCalledOnce();
    const postSnapshotFailure = new Error('Sample final observation failure');
    mocks.automation.getDialog.mockReturnValue(dialog);
    mocks.automation.takeSnapshot.mockRejectedValueOnce(postSnapshotFailure);
    await expect(input('press_key', true)).rejects.toBe(postSnapshotFailure);
    expect(postSnapshotFailure.message).toBe('Sample final observation failure');
  });

  it('uses the same formatter for explicit and action snapshots, and saves .txt without returning the tree', async () => {
    await expect(core.take_snapshot({ ...ctx, files })).resolves.toBe(embeddedSnapshot);
    await expect(core.take_snapshot({ ...ctx, files, verbose: true, filePath: 'result.log' })).resolves.toBe('Saved snapshot to /workspace/output.txt.');
    expect(mocks.files.validateObservationFile).toHaveBeenCalledWith('result.log', '.txt', files);
    expect(mocks.files.saveObservationFile).toHaveBeenCalledWith(new TextEncoder().encode(snapshotText), 'result.log', '.txt', files);
    expect(mocks.automation.takeSnapshot).toHaveBeenCalledWith(true, 7);
  });

  it('wait_for passes any-match text arrays and always returns the latest AX', async () => {
    await expect(core.wait_for({ ...ctx, text: ['Ready', 'Complete'], timeout: 2_000 }))
      .resolves.toBe(`Element matching one of ["Ready","Complete"] found.\n${embeddedSnapshot}`);
    expect(mocks.automation.waitForTextOnPage).toHaveBeenCalledExactlyOnceWith(['Ready', 'Complete'], 2_000, 7);
    expect(mocks.automation.takeSnapshot).toHaveBeenCalledExactlyOnceWith(false, 7);
  });

  it('lists stable page IDs, titles, selected state and isolated contexts; consumes selection fallback', async () => {
    mocks.automation.getSelectedPageId.mockReturnValue(7);
    await expect(core.list_pages({ browserId: 'browser-a' })).resolves.toBe(`${pagesText.replace(' isolatedContext=', ' [selected] isolatedContext=')}`);
    mocks.automation.consumeSelectedPageFallback.mockReturnValueOnce({ wasClosed: true });
    await expect(core.list_pages({ browserId: 'browser-a' })).resolves.toBe(
      `Note: the previously selected page was closed. Page 7 is now selected.\n${pagesText.replace(' isolatedContext=', ' [selected] isolatedContext=')}`,
    );
  });

  it('new_page passes URL, background/context and timeout, returning pages without an old selected-page feedback or AX', async () => {
    await expect(core.new_page({ browserId: 'browser-a', url: 'about:blank', background: true, isolatedContext: 'sample-context', timeout: -1 }))
      .resolves.toBe(pagesText);
    expect(mocks.automation.newPage).toHaveBeenCalledExactlyOnceWith('about:blank', undefined, { background: true, isolatedContext: 'sample-context' });
    expect(mocks.runExclusive).toHaveBeenCalledWith('browser-a', expect.any(Function), undefined, { feedback: false });
    expect(mocks.automation.takeSnapshot).not.toHaveBeenCalled();
  });

  it('close_page uses stable IDs and preserves last-page refusal as an ordinary result', async () => {
    await expect(core.close_page(ctx)).resolves.toBe(pagesText);
    mocks.automation.closePageById.mockRejectedValueOnce(new Error('The last open page cannot be closed. It is fine to keep it open.'));
    await expect(core.close_page(ctx)).resolves.toBe(`The last open page cannot be closed. It is fine to keep it open.\n${pagesText}`);
    expect(mocks.automation.closePageById).toHaveBeenCalledWith(7);
  });

  it('navigate_page delegates the complete request and consumes the owner source message', async () => {
    const request = { ...ctx, type: 'reload' as const, ignoreCache: true, handleBeforeUnload: 'dismiss' as const, initScript: 'window.sampleFlag = true;', timeout: 0 };
    mocks.operations.navigateInSession.mockResolvedValueOnce({
      type: 'reload', url: 'https://example.test/target', title: 'Sample page',
      receipt: { ...mocks.receipt, dialogHandled: true }, message: 'Unable to reload the selected page: Sample failure.',
    });
    await expect(core.navigate_page(request)).resolves.toBe(`Unable to reload the selected page: Sample failure.\nDismissed a beforeunload dialog.\n${pagesText}`);
    expect(mocks.operations.navigateInSession).toHaveBeenCalledExactlyOnceWith(mocks.automation, {
      pageId: 7, type: 'reload', url: undefined, ignoreCache: true, handleBeforeUnload: 'dismiss', initScript: 'window.sampleFlag = true;', timeout: undefined,
    });
    expect(mocks.automation.throwIfDialogOpen).not.toHaveBeenCalled();
    expect(mocks.automation.takeSnapshot).not.toHaveBeenCalled();
  });

  it('validates navigation URLs with the fixed JavaScript-enabled, non-extension rules', async () => {
    await expect(core.new_page({ browserId: 'browser-a', url: 'missing-scheme' })).rejects.toThrow('Invalid URL:');
    await expect(core.navigate_page({ ...ctx, url: 'chrome://settings/' })).rejects.toThrow('Navigating to chrome: URLs is not allowed.');
    await expect(core.new_page({ browserId: 'browser-a', url: 'chrome-extension://sample/page.html' })).rejects.toThrow('without --categoryExtensions');
    await expect(core.new_page({ browserId: 'browser-a', url: 'data:text/html,Sample' })).resolves.toBe(pagesText);
  });

  it('handle_dialog targets the specified page and returns source text with pages', async () => {
    await expect(core.handle_dialog({ ...ctx, action: 'accept', promptText: 'Sample response' }))
      .resolves.toBe(`Successfully accepted the dialog\n${pagesText}`);
    expect(mocks.automation.handleDialog).toHaveBeenCalledExactlyOnceWith('accept', 'Sample response', 7);
    expect(mocks.automation.throwIfDialogOpen).not.toHaveBeenCalled();
  });

  it('screenshot carries small image bytes/MIME and delegates element ownership to the helper', async () => {
    await expect(core.take_screenshot({ ...ctx, files })).resolves.toEqual({
      text: "Took a screenshot of the current page's viewport.", image: { mimeType: 'image/png', data: Buffer.from('page-image').toString('base64') },
    });
    await expect(core.take_screenshot({ ...ctx, files, uid: '7_1', format: 'webp', quality: 42 })).resolves.toMatchObject({ image: { mimeType: 'image/webp' } });
    expect(mocks.automation.getElementByUid).toHaveBeenCalledExactlyOnceWith('7_1', 7);
    expect(mocks.element.dispose).toHaveBeenCalledOnce();
    expect(mocks.automation.takeSnapshot).not.toHaveBeenCalled();
  });

  it('evaluate_script passes UID args and wait options without the definePageTool dialog precheck or response decoration', async () => {
    mocks.automation.getDialog.mockReturnValue(dialog);
    await expect(core.evaluate_script({ ...ctx, files, function: '(el) => el.textContent', args: ['7_1'], dialogAction: 'dismiss', waitForStableDom: false }))
      .resolves.toBe('Script ran on page and returned:\n```json\n{"ready":true}\n```');
    expect(mocks.automation.getPageById).toHaveBeenCalledExactlyOnceWith(7);
    expect(mocks.automation.getElementByUid).toHaveBeenCalledExactlyOnceWith('7_1', 7);
    expect(mocks.automation.waitForAction).toHaveBeenCalledWith(expect.any(Function), { pageId: 7, handleDialog: 'dismiss', waitForStableDom: false, signal: undefined });
    expect(mocks.automation.throwIfDialogOpen).not.toHaveBeenCalled();
    expect(mocks.automation.getDialog).not.toHaveBeenCalled();
    expect(mocks.element.dispose).toHaveBeenCalledOnce();
    expect(mocks.functionHandle.dispose).toHaveBeenCalledOnce();
  });

  it('routes all four data tools to target-page collectors with complete options and files', async () => {
    const consoleOptions = { ...ctx, files, types: ['issue' as const], includeStackTraces: true, includePreservedMessages: true, serviceWorkerId: 'worker-sample', pageIdx: 1, pageSize: 5 };
    await core.list_console_messages(consoleOptions);
    await core.get_console_message({ ...ctx, files, msgid: 11 });
    const networkOptions = { ...ctx, resourceTypes: ['fetch' as const], includePreservedRequests: true, pageIdx: 1, pageSize: 5 };
    await core.list_network_requests(networkOptions);
    await core.get_network_request({ ...ctx, files, reqid: 21, requestFilePath: 'request.txt', responseFilePath: 'response.txt' });
    expect(mocks.data.listConsoleMessages).toHaveBeenCalledWith(mocks.consoleCollector, consoleOptions, expect.objectContaining({ serviceWorkers: mocks.serviceWorkers }));
    expect(mocks.data.getConsoleMessage).toHaveBeenCalledWith(mocks.consoleCollector, 11,
      expect.objectContaining({ files, requestIdResolver: expect.any(Function), elementIdResolver: expect.any(Function) }));
    expect(mocks.data.listNetworkRequests).toHaveBeenCalledWith(mocks.page, mocks.networkCollector, networkOptions);
    expect(mocks.data.getNetworkRequest).toHaveBeenCalledWith(mocks.page, mocks.networkCollector, expect.objectContaining({ reqid: 21, requestFilePath: 'request.txt', responseFilePath: 'response.txt' }), files);
    expect(mocks.automation.getConsoleCollector).toHaveBeenCalledWith(7);
    expect(mocks.automation.getNetworkCollector).toHaveBeenCalledWith(7);
    expect(mocks.automation.throwIfDialogOpen).toHaveBeenCalledTimes(1);
    expect(mocks.automation.takeSnapshot).not.toHaveBeenCalled();
    expect(mocks.runExclusive).toHaveBeenCalledWith('browser-a', expect.any(Function), undefined, { pageId: 7, feedback: false });
  });

  it('returns screenshot images through the current Skill result channel', async () => {
    const signal = new AbortController().signal;
    const output = await skill.functions.take_screenshot.run({ pageId: 7, format: 'png' }, {
      browserId: 'browser-a', signal, log: vi.fn(), workspace: { dir: files.cwd, tempDir: files.tempDir },
      browser: { core } as never,
    });
    expect(output).toEqual({ ok: true, text: "Took a screenshot of the current page's viewport.", images: [{ mediaType: 'image/png', base64: Buffer.from('page-image').toString('base64') }] });
  });

  it('keeps cookies, windows and browser closure on their browser-level contracts', async () => {
    await expect(core.getAllCookies({ browserId: 'browser-a' })).resolves.toBe(JSON.stringify({ success: true, count: 1, cookies: [{ name: 'sample', value: 'example' }] }, null, 2));
    await expect(core.setCookies({ browserId: 'browser-a', cookies: [{ name: 'sample', value: 'example' }] })).resolves.toBe(JSON.stringify({ success: true, count: 1 }, null, 2));
    await expect(core.deleteCookies({ browserId: 'browser-a', cookies: [{ name: 'sample', domain: 'example.test' }] })).resolves.toBe(JSON.stringify({ success: true, count: 1 }, null, 2));
    await expect(core.clearCookies({ browserId: 'browser-a' })).resolves.toBe(JSON.stringify({ success: true }, null, 2));
    await expect(core.getWindowBounds({ browserId: 'browser-a' })).resolves.toContain('"width": 800');
    await expect(core.setWindowBounds({ browserId: 'browser-a', bounds: { width: 900 } })).resolves.toContain('"width": 900');
    await expect(core.closeBrowser({ browserId: 'browser-a' })).resolves.toBe('Browser browser-a closed successfully');
    expect(mocks.runExclusive).not.toHaveBeenCalled();
  });
});
