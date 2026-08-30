/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * chrome-devtools-mcp 1.7.0 tool schemas are adapted to Piskie's camelCase
 * browser contract and trusted host context.
 */

import { bool, int, num, ok, z } from '../../../core/skill/define.js';
import { defineTrustedBrowserSkill } from '../../../core/skill/host.js';

const CONSOLE_MESSAGE_TYPES = [
  'log', 'debug', 'info', 'error', 'warn', 'dir', 'dirxml', 'table', 'trace',
  'clear', 'startGroup', 'startGroupCollapsed', 'endGroup', 'assert', 'profile',
  'profileEnd', 'count', 'timeEnd', 'verbose',
] as const;

const NETWORK_RESOURCE_TYPES = [
  'document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack',
  'xhr', 'fetch', 'prefetch', 'eventsource', 'websocket', 'manifest',
  'signedexchange', 'ping', 'cspviolationreport', 'preflight', 'fedcm', 'other',
] as const;

const browserContext = <T extends Record<string, unknown>>(
  params: T,
  ctx: { browserId: string },
): T & { browserId: string } => ({
  ...params,
  browserId: ctx.browserId,
});

const skill = defineTrustedBrowserSkill({
  name: 'browser',
  domain: 'browser',
  functions: {
    takeSnapshot: {
      description: "Take a text snapshot of the currently selected page based on the accessibility tree. The snapshot lists page elements along with a unique identifier (uid). UID lifecycle: each takeSnapshot generates a NEW snapshot and immediately invalidates all UIDs from previous snapshots — use UIDs right after taking the snapshot, and never reuse UIDs across snapshots. Prefer taking a snapshot over taking a screenshot.",
      params: z.object({ "verbose": bool().default(false).describe("Whether to include all possible information available in the full a11y tree. Default is false.") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.takeSnapshot(browserContext(params, ctx)));
      },
    },
    clickByUid: {
      description: "Clicks on the provided element identified by its UID from the page content snapshot. The UID must come from the LATEST snapshot — any takeSnapshot call (including the auto-snapshot after click/fill) invalidates all earlier UIDs. After clicking, automatically detects if new tabs were opened or closed, and includes this information in the response. This helps you know immediately if a new page opened without manually calling listPages. IMPORTANT: The snapshot is taken immediately after the click. If the snapshot shows \"loading\", incomplete content, or doesn't match expectations, the page may still be loading data via AJAX/fetch. Wait 2-3 seconds and call takeSnapshot again to get the complete state.",
      params: z.object({ "uid": z.string().regex(new RegExp("^\\d+_\\d+$")).describe("The uid of an element on the page from the page content snapshot (format: snapshotId_nodeIndex, e.g., \"10_116\")"), "dblClick": bool().default(false).describe("Set to true for double clicks. Default is false.") }),
      async run({ uid: elementUid, dblClick }, ctx) {
        return ok(await ctx.browser.core.clickByUid({
          uid: elementUid,
          clickCount: dblClick ? 2 : 1,
          browserId: ctx.browserId,
        }));
      },
    },
    fillByUid: {
      description: "Type text into an input, text area or select an option from a <select> element identified by its UID. The UID must come from the LATEST snapshot — any takeSnapshot call (including the auto-snapshot after click/fill) invalidates all earlier UIDs. After filling, automatically detects if new tabs were opened or closed (e.g., autocomplete triggered a popup), and includes this information in the response. IMPORTANT: The snapshot is taken immediately after filling. If the snapshot shows \"loading\", incomplete content, or doesn't match expectations, the page may still be loading data via AJAX/fetch. Wait 2-3 seconds and call takeSnapshot again to get the complete state.",
      params: z.object({ "uid": z.string().regex(new RegExp("^\\d+_\\d+$")).describe("The uid of an element on the page from the page content snapshot"), "value": z.string().describe("The value to fill in (text for input/textarea, option text for select)") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.fillByUid(browserContext(params, ctx)));
      },
    },
    pressKey: {
      description: "Press a key or key combination. Use this when other input methods like fill() cannot be used (e.g., keyboard shortcuts, navigation keys, or special key combinations). Examples: \"Enter\", \"Control+A\", \"Control++\", \"Control+Shift+R\". Modifiers: Control, Shift, Alt, Meta",
      params: z.object({ "key": z.string().describe("A key or a combination. Examples: \"Enter\", \"Tab\", \"Escape\", \"Control+A\", \"Control+Shift+R\", \"PageDown\", \"ArrowUp\". Available modifiers: Control, Shift, Alt, Meta"), "count": num(z.gte(1)).default(1).describe("Number of times to press the key (deprecated, use count=1 and call multiple times if needed)") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.pressKey(browserContext(params, ctx)));
      },
    },
    navigateTo: {
      description: "Navigates the currently selected page to a URL, or performs history navigation (back/forward/reload). Returns a snapshot after navigation completes. IMPORTANT: If the snapshot shows \"loading\", incomplete content, or doesn't match expectations, the page may still be loading data via AJAX/fetch. Wait 2-3 seconds and call takeSnapshot again to get the complete state.",
      params: z.object({ "type": z.enum(["url", "back", "forward", "reload"]).optional().describe("Navigate the page by URL, back or forward in history, or reload. Defaults to \"url\" if url parameter is provided"), "url": z.string().regex(new RegExp("^https?://")).optional().describe("Target URL (required only when type=url or type is omitted)"), "ignoreCache": bool().default(false).describe("Whether to ignore cache on reload (only applicable for type=reload)"), "timeout": num(z.gte(0), z.lte(300000)).default(30000).describe("Maximum wait time in milliseconds. If set to 0, the default timeout will be used.") }),
      async run(params, ctx) {
        const text = await ctx.browser.core.navigateTo({
          ...browserContext(params, ctx),
          signal: ctx.signal,
        } as Parameters<typeof ctx.browser.core.navigateTo>[0]);
        ctx.browser.notifyPageOpen();
        return ok(text);
      },
    },
    goBack: {
      description: "Navigate back in browser history. Equivalent to navigateTo with type=\"back\" — either works; do not call both.",
      params: z.object({}),
      async run(params, ctx) {
        return ok(await ctx.browser.core.goBack(browserContext(params, ctx)));
      },
    },
    refresh: {
      description: "Refresh the current page. Equivalent to navigateTo with type=\"reload\" — either works; do not call both.",
      params: z.object({}),
      async run(_params, ctx) {
        return ok(await ctx.browser.core.refresh({ browserId: ctx.browserId }));
      },
    },
    newPage: {
      description: "Open a new page/tab in the browser and load the specified URL",
      params: z.object({ "url": z.string().describe("Target URL to load in the new page. Include a scheme, e.g. https://example.com, http://localhost:3000, about:blank, or file:///path/to/file.html.") }),
      async run(params, ctx) {
        const text = await ctx.browser.core.newPage(browserContext(params, ctx));
        ctx.browser.notifyPageOpen();
        return ok(text);
      },
    },
    closePage: {
      description: "Close the page/tab at the specified index (use listPages to get page indexes)",
      params: z.object({ "pageIndex": num(z.gte(0)).describe("Index of the page to close") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.closePage(browserContext(params, ctx)));
      },
    },
    closeBrowser: {
      description: "Close a browser instance by browserId. This will terminate the Chrome process and delete the persisted config. The browser can be reopened later with a new session.",
      params: z.object({}),
      async run(_params, ctx) {
        return ok(await ctx.browser.core.closeBrowser({ browserId: ctx.browserId }));
      },
    },
    listPages: {
      description: "List all open pages/tabs in the browser",
      params: z.object({}),
      async run(params, ctx) {
        return ok(await ctx.browser.core.listPages(browserContext(params, ctx)));
      },
    },
    selectPage: {
      description: "Select a different page/tab by index for subsequent browser operations. Always call listPages first to see available pages and their indices. If the page is still loading or incomplete, wait briefly and call takeSnapshot again.",
      params: z.object({ "pageIdx": num(z.gte(0)).describe("Index of the page to switch to (0-based). Use listPages to see available indices.") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.selectPage(browserContext(params, ctx)));
      },
    },
    handleDialog: {
      description: "Accept or dismiss the browser dialog currently open on the selected page. Use promptText when accepting a prompt dialog.",
      params: z.object({
        "action": z.enum(["accept", "dismiss"]).describe("Whether to accept or dismiss the dialog"),
        "promptText": z.string().optional().describe("Optional text to enter when accepting a prompt dialog"),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.handleDialog(browserContext(params, ctx)));
      },
    },
    waitFor: {
      description: "Wait until any one of the specified texts appears on the selected page, then return a fresh page snapshot.",
      params: z.object({
        "text": z.array(z.string()).min(1).describe("Non-empty list of texts; resolves when any value appears"),
        "timeout": int(z.gte(0), z.lte(300000)).optional().describe("Maximum wait time in milliseconds; 0 uses the default timeout"),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.waitFor(browserContext(params, ctx)));
      },
    },
    hoverByUid: {
      description: "Hover the mouse over an element identified by its UID. Useful for triggering hover effects, tooltips, or dropdown menus.",
      params: z.object({ "uid": z.string().regex(new RegExp("^\\d+_\\d+$")).describe("The uid of an element on the page from the page content snapshot") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.hoverByUid(browserContext(params, ctx)));
      },
    },
    drag: {
      description: "Drag an element onto another element. Both UIDs must come from the latest page snapshot. Returns a fresh snapshot after the drag.",
      params: z.object({
        "fromUid": z.string().regex(new RegExp("^\\d+_\\d+$")).describe("The uid of the element to drag"),
        "toUid": z.string().regex(new RegExp("^\\d+_\\d+$")).describe("The uid of the element to drop into"),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.drag(browserContext(params, ctx)));
      },
    },
    uploadFile: {
      description: "Upload a local file through a file input or an element that opens a file chooser. The file must be inside the current workspace or its temporary directory. Returns a fresh snapshot after the upload.",
      params: z.object({
        "uid": z.string().regex(new RegExp("^\\d+_\\d+$")).describe("The uid of the file input or file-chooser trigger from the latest page snapshot"),
        "filePath": z.string().describe("Absolute local path of the file to upload"),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.uploadFile({
          ...browserContext(params, ctx),
          allowedRoots: [ctx.workspace.dir, ctx.workspace.tempDir],
        }));
      },
    },
    fillFormByUids: {
      description: "Fill multiple form fields in one operation. All UIDs must come from the SAME (latest) snapshot — mixing UIDs from different snapshots will fail. Automatically creates a new snapshot after filling (which invalidates the UIDs just used). Use this to efficiently fill multiple inputs, selects, or textareas at once.",
      params: z.object({ "elements": z.array(z.object({ "uid": z.string().regex(new RegExp("^\\d+_\\d+$")).describe("The uid of the form element"), "value": z.string().describe("The value to fill in") })).min(1).describe("Array of form elements to fill") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.fillFormByUids(browserContext(params, ctx)));
      },
    },
    takeScreenshot: {
      description: "Take a screenshot of the page or element.",
      params: z.object({ "format": z.enum(["png", "jpeg", "webp"]).default("png").describe("Type of format to save the screenshot as. Default is \"png\""), "fullPage": bool().optional().describe("If set to true takes a screenshot of the full page instead of the currently visible viewport. Incompatible with uid."), "quality": num(z.gte(0), z.lte(100)).optional().describe("Compression quality for JPEG and WebP formats (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format."), "uid": z.string().optional().describe("The uid of an element on the page content snapshot. If omitted, takes a screenshot of the full page.") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.takeScreenshot(browserContext(params, ctx)));
      },
    },
    evaluateScript: {
      description: "Execute a JavaScript function in the browser context. The function must be a valid JavaScript function expression. The return value MUST be JSON-serializable — returning DOM nodes, functions, or circular structures fails; extract plain data instead. Example: \"() => Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent, href: a.href }))\".",
      params: z.object({ "function": z.string().describe("A JavaScript function as a string (e.g., \"() => document.title\" or \"() => { return document.querySelectorAll('a').length; }\")") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.evaluateScript(browserContext(params, ctx)));
      },
    },
    listConsoleMessages: {
      description: "Read console messages collected for the selected page since its latest navigation.",
      params: z.object({
        "pageSize": int(z.gt(0)).optional().describe("Maximum number of messages to return; omit to return all messages"),
        "pageIdx": int(z.gte(0)).optional().describe("Zero-based result page; defaults to the first page"),
        "types": z.array(z.enum(CONSOLE_MESSAGE_TYPES)).optional().describe("Only return the selected console message types"),
        "includePreservedMessages": bool().default(false).describe("Include messages preserved over the last three navigations"),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.listConsoleMessages(browserContext(params, ctx)));
      },
    },
    getConsoleMessage: {
      description: "Read one console message in detail by the msgid returned from listConsoleMessages.",
      params: z.object({
        "msgid": z.number().describe("The msgid returned by listConsoleMessages"),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.getConsoleMessage(browserContext(params, ctx)));
      },
    },
    listNetworkRequests: {
      description: "Read network requests collected for the selected page since its latest navigation.",
      params: z.object({
        "pageSize": int(z.gt(0)).optional().describe("Maximum number of requests to return; omit to return all requests"),
        "pageIdx": int(z.gte(0)).optional().describe("Zero-based result page; defaults to the first page"),
        "resourceTypes": z.array(z.enum(NETWORK_RESOURCE_TYPES)).optional().describe("Only return the selected resource types"),
        "includePreservedRequests": bool().default(false).describe("Include requests preserved over the last three navigations"),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.listNetworkRequests(browserContext(params, ctx)));
      },
    },
    getNetworkRequest: {
      description: "Read request and response headers and available bodies for a reqid returned by listNetworkRequests. This tool does not write body files.",
      params: z.object({
        "reqid": z.number().optional().describe("The reqid returned by listNetworkRequests; when omitted, reports that no DevTools request is selected"),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.getNetworkRequest(browserContext(params, ctx)));
      },
    },
    getAllCookies: {
      description: "Export all cookies (whole cookie store, including httpOnly) via CDP Network domain. Returns JSON { success, count, cookies }. The cookies array can be fed directly back to setCookies for account migration.",
      params: z.object({ "urls": z.array(z.string()).optional().describe("Optional: only return cookies matching these URLs; omit to return the entire cookie store") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.getAllCookies(browserContext(params, ctx)));
      },
    },
    setCookies: {
      description: "Import cookies via CDP Network domain. Accepts a standard cookie JSON array (CDP CookieParam: name/value/domain/path/url/expires/httpOnly/secure/sameSite).",
      params: z.object({ "cookies": z.array(z.looseObject({})).describe("Cookie objects to set (CDP CookieParam shape)") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.setCookies(browserContext(params, ctx)));
      },
    },
    deleteCookies: {
      description: "Delete specific cookies (one Network.deleteCookies per item). Each item needs a name and at least a url or domain to locate it.",
      params: z.object({ "cookies": z.array(z.looseObject({})).describe("Cookies to delete; each item requires name plus url or domain") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.deleteCookies(browserContext(params, ctx)));
      },
    },
    clearCookies: {
      description: "Clear all cookies in the browser (Network.clearBrowserCookies).",
      params: z.object({}),
      async run(params, ctx) {
        return ok(await ctx.browser.core.clearCookies(browserContext(params, ctx)));
      },
    },
    getWindowBounds: {
      description: "Read the browser window position/size/state. Returns JSON { success, bounds: { left, top, width, height, windowState } }.",
      params: z.object({}),
      async run(params, ctx) {
        return ok(await ctx.browser.core.getWindowBounds(browserContext(params, ctx)));
      },
    },
    setWindowBounds: {
      description: "Set the browser window position/size/state (used for tiling). When geometry (left/top/width/height) is provided, the window is switched to normal state first. Returns JSON { success, bounds } with the actual bounds after applying.",
      params: z.object({ "bounds": z.object({ "left": num().optional(), "top": num().optional(), "width": num().optional(), "height": num().optional(), "windowState": z.enum(["normal", "minimized", "maximized", "fullscreen"]).optional() }).describe("Target window bounds") }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.setWindowBounds(browserContext(params, ctx)));
      },
    },
  },
});

export default skill;
