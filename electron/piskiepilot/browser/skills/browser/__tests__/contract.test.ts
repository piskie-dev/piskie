import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from '../../../../core/skill/define.js';

const mocks = vi.hoisted(() => {
  const receipt = {
    navigated: false,
    domSettled: true,
    openedPageIds: [],
    closedPageIds: [],
  };
  const child = {
    id: '7_1',
    role: 'button',
    name: 'Save',
    children: [],
  };
  const root = {
    id: '7_0',
    role: 'textbox',
    name: 'Name',
    value: 'Ada',
    children: [child],
  };
  const snapshot = {
    snapshotId: '7',
    root,
    idToNode: new Map([['7_0', root], ['7_1', child]]),
    verbose: false,
  };
  const functionHandle = { dispose: vi.fn(async () => undefined) };
  const element = {
    screenshot: vi.fn(async () => Buffer.from('element-image')),
    dispose: vi.fn(async () => undefined),
  };
  const consoleArgument = { jsonValue: vi.fn(async () => ({ code: 500 })) };
  const consoleMessage = {
    type: vi.fn(() => 'error'),
    text: vi.fn(() => 'boom'),
    args: vi.fn(() => [consoleArgument]),
  };
  const networkResponse = {
    status: vi.fn(() => 200),
    headers: vi.fn(() => ({ 'content-type': 'application/json' })),
    buffer: vi.fn(async () => Buffer.from('{"ok":true}')),
  };
  const networkRequest = {
    method: vi.fn(() => 'GET'),
    url: vi.fn(() => 'https://example.test/api'),
    resourceType: vi.fn(() => 'fetch'),
    headers: vi.fn(() => ({ accept: 'application/json' })),
    response: vi.fn(() => networkResponse),
    failure: vi.fn(() => null),
    hasPostData: vi.fn(() => false),
    postData: vi.fn(() => undefined),
    fetchPostData: vi.fn(async () => undefined),
    redirectChain: vi.fn(() => []),
  };
  const page = {
    url: vi.fn(() => 'https://example.test/current'),
    title: vi.fn(async () => 'Example'),
    screenshot: vi.fn(async () => Buffer.from('page-image')),
    evaluateHandle: vi.fn(async () => functionHandle),
    evaluate: vi.fn(async () => JSON.stringify({ ok: true })),
    goBack: vi.fn(async () => null),
    reload: vi.fn(async () => null),
  };
  const automation = {
    takeSnapshot: vi.fn(async () => snapshot),
    clickByUid: vi.fn(async () => receipt),
    fillByUid: vi.fn(async () => receipt),
    hoverByUid: vi.fn(async () => receipt),
    fillFormByUids: vi.fn(async () => receipt),
    dragByUids: vi.fn(async () => receipt),
    uploadFileByUid: vi.fn(async () => undefined),
    handleDialog: vi.fn(async () => undefined),
    waitForTextOnPage: vi.fn(async () => undefined),
    pressKey: vi.fn(async () => receipt),
    newPage: vi.fn(async () => page),
    closePageByIndex: vi.fn(async () => undefined),
    selectPageByIndex: vi.fn(async () => page),
    listPages: vi.fn(async () => [{ pageId: 3, page, navigationSequence: 0 }]),
    getSelectedPageIndex: vi.fn(() => 0),
    getSelectedPage: vi.fn(() => page),
    getElementByUid: vi.fn(async () => element),
    waitForAction: vi.fn(async (action: () => Promise<unknown>) => {
      await action();
      return receipt;
    }),
    getConsoleData: vi.fn(() => [consoleMessage]),
    getConsoleMessageById: vi.fn(() => consoleMessage),
    getConsoleMessageId: vi.fn(() => 11),
    getNetworkRequests: vi.fn(() => [networkRequest]),
    getNetworkRequestById: vi.fn(() => networkRequest),
    getNetworkRequestId: vi.fn(() => 21),
    throwIfDialogOpen: vi.fn(),
    consumePageChanges: vi.fn(async () => ({ opened: [], closed: [] })),
  };
  const runExclusive = vi.fn(
    async (_browserId: string, action: (session: { automation: typeof automation }) => unknown) =>
      action({ automation })
  );
  const operations = {
    navigateInSession: vi.fn(async () => ({
      type: 'url',
      url: 'https://example.test/current',
      title: 'Example',
      receipt,
    })),
    close: vi.fn(async () => undefined),
    getAllCookies: vi.fn(async () => ({
      success: true,
      count: 1,
      cookies: [{ name: 'session', value: 'secret' }],
    })),
    setCookies: vi.fn(async (request: { cookies: unknown[] }) => ({
      success: true,
      count: request.cookies.length,
    })),
    deleteCookies: vi.fn(async (request: { cookies: unknown[] }) => ({
      success: true,
      count: request.cookies.length,
    })),
    clearCookies: vi.fn(async () => ({ success: true })),
    getWindowBounds: vi.fn(async () => ({ left: 1, top: 2, width: 800, height: 600 })),
    setWindowBounds: vi.fn(async () => ({ left: 10, top: 20, width: 900, height: 700 })),
  };
  const validatePathWithinRoots = vi.fn(async () => undefined);
  return {
    automation,
    child,
    consoleMessage,
    element,
    functionHandle,
    networkRequest,
    operations,
    page,
    receipt,
    root,
    runExclusive,
    snapshot,
    validatePathWithinRoots,
  };
});

vi.mock('../../../core/browser/browser-manager.js', () => ({
  BrowserManager: { runExclusive: mocks.runExclusive },
}));

vi.mock('../../../core/browser/browser-operations.js', () => ({
  BrowserOperations: mocks.operations,
}));

vi.mock('../../../core/session/file-roots.js', () => ({
  validatePathWithinRoots: mocks.validatePathWithinRoots,
}));

import browserCoreSkill from '../skill.js';
import * as browserCore from '../index.js';

const standaloneSnapshot = [
  '# Page Snapshot (ID: 7)',
  '',
  '## Element Tree',
  '```',
  '[7_0] textbox "Name" = "Ada"',
  '  [7_1] button "Save"',
  '```',
].join('\n');

const embeddedSnapshot = [
  '## Page Snapshot',
  '[7_0] textbox "Name"',
  '  [7_1] button "Save"',
  '',
].join('\n');

const pages = '\n\n## Pages\n0: https://example.test/current [selected]\n';

describe('browser public contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.automation.consumePageChanges.mockResolvedValue({ opened: [], closed: [] });
    mocks.automation.closePageByIndex.mockResolvedValue(undefined);
    mocks.operations.navigateInSession.mockResolvedValue({
      type: 'url',
      url: 'https://example.test/current',
      title: 'Example',
      receipt: mocks.receipt,
    });
  });

  it('freezes all 30 function names and top-level input fields', () => {
    const actual = Object.fromEntries(
      Object.entries(browserCoreSkill.functions).map(([name, definition]) => {
        const schema = z.toJSONSchema(definition.params, { target: 'draft-7', io: 'input' });
        return [name, {
          properties: Object.keys(schema.properties ?? {}).sort(),
          required: [...(schema.required ?? [])].sort(),
        }];
      })
    );

    expect(actual).toEqual({
      takeSnapshot: { properties: ['verbose'], required: [] },
      clickByUid: { properties: ['dblClick', 'uid'], required: ['uid'] },
      fillByUid: { properties: ['uid', 'value'], required: ['uid', 'value'] },
      pressKey: { properties: ['count', 'key'], required: ['key'] },
      navigateTo: { properties: ['ignoreCache', 'timeout', 'type', 'url'], required: [] },
      goBack: { properties: [], required: [] },
      refresh: { properties: [], required: [] },
      newPage: { properties: ['url'], required: ['url'] },
      closePage: { properties: ['pageIndex'], required: [] },
      closeBrowser: { properties: [], required: [] },
      listPages: { properties: [], required: [] },
      selectPage: { properties: ['pageIdx'], required: [] },
      handleDialog: { properties: ['action', 'promptText'], required: ['action'] },
      waitFor: { properties: ['text', 'timeout'], required: ['text'] },
      hoverByUid: { properties: ['uid'], required: ['uid'] },
      drag: { properties: ['fromUid', 'toUid'], required: ['fromUid', 'toUid'] },
      uploadFile: { properties: ['filePath', 'uid'], required: ['filePath', 'uid'] },
      fillFormByUids: { properties: ['elements'], required: ['elements'] },
      takeScreenshot: {
        properties: ['format', 'fullPage', 'quality', 'uid'],
        required: [],
      },
      evaluateScript: { properties: ['function'], required: ['function'] },
      listConsoleMessages: {
        properties: ['includePreservedMessages', 'pageIdx', 'pageSize', 'types'],
        required: [],
      },
      getConsoleMessage: { properties: ['msgid'], required: ['msgid'] },
      listNetworkRequests: {
        properties: ['includePreservedRequests', 'pageIdx', 'pageSize', 'resourceTypes'],
        required: [],
      },
      getNetworkRequest: { properties: ['reqid'], required: [] },
      getAllCookies: { properties: ['urls'], required: [] },
      setCookies: { properties: ['cookies'], required: ['cookies'] },
      deleteCookies: { properties: ['cookies'], required: ['cookies'] },
      clearCookies: { properties: [], required: [] },
      getWindowBounds: { properties: [], required: [] },
      setWindowBounds: { properties: ['bounds'], required: ['bounds'] },
    });
  });

  it('preserves standalone and post-action snapshot text', async () => {
    await expect(browserCore.takeSnapshot({ browserId: 'browser-a' })).resolves.toBe(
      standaloneSnapshot
    );
    await expect(browserCore.clickByUid({ uid: '7_1', browserId: 'browser-a' })).resolves.toBe(
      `Successfully clicked on the element\n\n${embeddedSnapshot}`
    );
    await expect(browserCore.fillByUid({
      uid: '7_0',
      value: 'Grace',
      browserId: 'browser-a',
    })).resolves.toBe(`Successfully filled out the element\n\n${embeddedSnapshot}`);
    await expect(browserCore.hoverByUid({ uid: '7_1', browserId: 'browser-a' })).resolves.toBe(
      `Successfully hovered over the element\n\n${embeddedSnapshot}`
    );
    await expect(browserCore.fillFormByUids({
      elements: [{ uid: '7_0', value: 'Grace' }],
      browserId: 'browser-a',
    })).resolves.toBe(`Successfully filled out the form\n\n${embeddedSnapshot}`);
    await expect(browserCore.pressKey({ key: 'Enter', browserId: 'browser-a' })).resolves.toBe(
      `Successfully pressed key: Enter\n\n${embeddedSnapshot}`
    );

    expect(mocks.snapshot.root.value).toBe('Ada');
    expect(embeddedSnapshot).not.toContain(' = "Ada"');
  });

  it('exposes the ported dialog, wait, drag, upload, console, and network behavior', async () => {
    await expect(browserCore.handleDialog({
      action: 'accept',
      promptText: 'Grace',
      browserId: 'browser-a',
    })).resolves.toBe(`Successfully accepted the dialog${pages}`);
    await expect(browserCore.waitFor({
      text: ['Ready', 'Complete'],
      timeout: 2_000,
      browserId: 'browser-a',
    })).resolves.toBe(
      `Element matching one of ["Ready","Complete"] found.\n\n${embeddedSnapshot}`
    );
    await expect(browserCore.drag({
      fromUid: '7_0',
      toUid: '7_1',
      browserId: 'browser-a',
    })).resolves.toBe(`Successfully dragged an element\n\n${embeddedSnapshot}`);
    await expect(browserCore.uploadFile({
      uid: '7_0',
      filePath: '/workspace/upload.txt',
      allowedRoots: ['/workspace', '/tmp'],
      browserId: 'browser-a',
    })).resolves.toBe(`File uploaded from /workspace/upload.txt.\n\n${embeddedSnapshot}`);

    expect(mocks.automation.handleDialog).toHaveBeenCalledWith('accept', 'Grace');
    expect(mocks.automation.waitForTextOnPage).toHaveBeenCalledWith(
      ['Ready', 'Complete'],
      2_000,
    );
    expect(mocks.automation.dragByUids).toHaveBeenCalledWith('7_0', '7_1');
    expect(mocks.validatePathWithinRoots).toHaveBeenCalledWith(
      '/workspace/upload.txt',
      ['/workspace', '/tmp'],
    );
    expect(mocks.automation.uploadFileByUid).toHaveBeenCalledWith(
      '7_0',
      '/workspace/upload.txt',
    );

    await expect(browserCore.listConsoleMessages({ browserId: 'browser-a' })).resolves.toBe(
      '## Console messages\n'
      + 'Showing 1-1 of 1 (Page 1 of 1).\n'
      + 'msgid=11 [error] boom (1 args)'
    );
    await expect(browserCore.getConsoleMessage({
      msgid: 11,
      browserId: 'browser-a',
    })).resolves.toBe(
      'ID: 11\nMessage: error> boom\n### Arguments\nArg #0: {"code":500}'
    );
    await expect(browserCore.listNetworkRequests({ browserId: 'browser-a' })).resolves.toBe(
      '## Network requests\n'
      + 'Showing 1-1 of 1 (Page 1 of 1).\n'
      + 'reqid=21 GET https://example.test/api [200]'
    );
    await expect(browserCore.getNetworkRequest({
      reqid: 21,
      browserId: 'browser-a',
    })).resolves.toBe(
      '## Request https://example.test/api\n'
      + 'Status: 200\n'
      + '### Request Headers\n'
      + '- accept:application/json\n'
      + '### Response Headers\n'
      + '- content-type:application/json\n'
      + '### Response Body\n'
      + '{"ok":true}'
    );
    await expect(browserCore.getNetworkRequest({ browserId: 'browser-a' })).resolves.toBe(
      'Nothing is currently selected in the DevTools Network panel.'
    );
  });

  it('preserves navigation, page listing, and page-change text', async () => {
    await expect(browserCore.navigateTo({
      browserId: 'browser-a',
      url: 'https://example.test/current',
    })).resolves.toBe(`Successfully navigated to https://example.test/current.${pages}`);
    await expect(browserCore.newPage({
      browserId: 'browser-a',
      url: 'https://example.test/new',
    })).resolves.toBe(pages);
    await expect(browserCore.listPages({ browserId: 'browser-a' })).resolves.toBe(pages);
    await expect(browserCore.selectPage({ pageIdx: 0, browserId: 'browser-a' })).resolves.toBe(pages);
    await expect(browserCore.closePage({ pageIndex: 0, browserId: 'browser-a' })).resolves.toBe(pages);

    mocks.automation.closePageByIndex.mockRejectedValueOnce(
      new Error('The last open page cannot be closed. It is fine to keep it open.')
    );
    await expect(browserCore.closePage({ pageIndex: 0, browserId: 'browser-a' })).resolves.toBe(
      `The last open page cannot be closed. It is fine to keep it open.${pages}`
    );

    vi.clearAllMocks();
    await expect(browserCore.goBack({ browserId: 'browser-a' })).resolves.toBe(
      `Went back\n\n${standaloneSnapshot}`
    );
    await expect(browserCore.refresh({ browserId: 'browser-a' })).resolves.toBe(
      `Page refreshed\n\n${standaloneSnapshot}`
    );
    expect(mocks.page.goBack).toHaveBeenCalledWith({ waitUntil: 'networkidle2' });
    expect(mocks.page.reload).toHaveBeenCalledWith({ waitUntil: 'networkidle2' });
    expect(mocks.automation.consumePageChanges).not.toHaveBeenCalled();

    mocks.automation.consumePageChanges.mockResolvedValueOnce({
      opened: [{ pageId: 4, pageIndex: 1, url: 'https://example.test/new' }],
      closed: [{ pageId: 2, pageIndex: 1, url: 'https://example.test/old' }],
    });
    await expect(browserCore.listPages({ browserId: 'browser-a' })).resolves.toBe(
      `${pages}\n\n` +
      '🆕 New page(s) opened (1):\n' +
      '  - [1] https://example.test/new\n' +
      '🔒 Page(s) closed (1):\n' +
      '  - [1] https://example.test/old\n' +
      '📊 Total pages: 1 → 1'
    );
  });

  it('preserves upstream navigation failure text instead of converting it to an action error', async () => {
    mocks.operations.navigateInSession.mockResolvedValueOnce({
      type: 'url',
      url: 'https://example.test/current',
      title: 'Example',
      receipt: mocks.receipt,
      error: 'net::ERR_NAME_NOT_RESOLVED',
    });

    await expect(browserCore.navigateTo({
      browserId: 'browser-a',
      url: 'https://missing.example.test',
    })).resolves.toBe(
      `Unable to navigate in the selected page: net::ERR_NAME_NOT_RESOLVED.${pages}`
    );
  });

  it('preserves screenshot and script result text', async () => {
    await expect(browserCore.takeScreenshot({ browserId: 'browser-a' })).resolves.toBe(
      "Took a screenshot of the current page's viewport."
    );
    await expect(browserCore.takeScreenshot({
      browserId: 'browser-a',
      uid: '7_1',
    })).resolves.toBe('Took a screenshot of node with uid "7_1".');
    await expect(browserCore.evaluateScript({
      browserId: 'browser-a',
      function: '() => ({ ok: true })',
    })).resolves.toBe(
      'Script ran on page and returned:\n```json\n{"ok":true}\n```'
    );
    expect(mocks.element.dispose).toHaveBeenCalledOnce();
    expect(mocks.functionHandle.dispose).toHaveBeenCalledOnce();
  });

  it('keeps Cookie, window, and browser-close return shapes', async () => {
    await expect(browserCore.getAllCookies({ browserId: 'browser-a' })).resolves.toBe(
      JSON.stringify({
        success: true,
        count: 1,
        cookies: [{ name: 'session', value: 'secret' }],
      }, null, 2)
    );
    await expect(browserCore.setCookies({
      browserId: 'browser-a',
      cookies: [{ name: 'session', value: 'secret' }],
    })).resolves.toBe(JSON.stringify({ success: true, count: 1 }, null, 2));
    await expect(browserCore.deleteCookies({
      browserId: 'browser-a',
      cookies: [{ name: 'session', domain: '.example.test' }],
    })).resolves.toBe(JSON.stringify({ success: true, count: 1 }, null, 2));
    await expect(browserCore.clearCookies({ browserId: 'browser-a' })).resolves.toBe(
      JSON.stringify({ success: true }, null, 2)
    );
    await expect(browserCore.getWindowBounds({ browserId: 'browser-a' })).resolves.toBe(
      JSON.stringify({
        success: true,
        bounds: { left: 1, top: 2, width: 800, height: 600 },
      }, null, 2)
    );
    await expect(browserCore.setWindowBounds({
      browserId: 'browser-a',
      bounds: { left: 10, top: 20, width: 900, height: 700 },
    })).resolves.toBe(JSON.stringify({
      success: true,
      bounds: { left: 10, top: 20, width: 900, height: 700 },
    }, null, 2));
    await expect(browserCore.closeBrowser({ browserId: 'browser-a' })).resolves.toBe(
      'Browser browser-a closed successfully'
    );
  });
});
