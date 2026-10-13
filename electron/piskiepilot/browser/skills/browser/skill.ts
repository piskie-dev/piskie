/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/tools/{pages,input,snapshot,
 * screenshot,script,console,network,ToolDefinition}.ts, with pageIdRouting=true,
 * slim=false, JavaScript enabled, and no extension tools. Host context stays private.
 */

import { num, ok, z } from '../../../core/skill/define.js';
import {
  defineTrustedBrowserSkill,
  type TrustedBrowserSkillContext,
} from '../../../core/skill/host.js';

const CONSOLE_MESSAGE_TYPES = [
  'log', 'debug', 'info', 'error', 'warn', 'dir', 'dirxml', 'table', 'trace',
  'clear', 'startGroup', 'startGroupCollapsed', 'endGroup', 'assert', 'profile',
  'profileEnd', 'count', 'timeEnd', 'verbose', 'issue',
] as const;

const NETWORK_RESOURCE_TYPES = [
  'document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack',
  'xhr', 'fetch', 'prefetch', 'eventsource', 'websocket', 'manifest',
  'signedexchange', 'ping', 'cspviolationreport', 'preflight', 'fedcm', 'other',
] as const;

const pageIdSchema = {
  pageId: z.number().describe('Targets a specific page by ID.'),
};
// Keep the source input schema exportable; normalize nonpositive values in the handler.
const timeoutSchema = {
  timeout: z.number().int().optional().describe(
    'Maximum wait time in milliseconds. If set to 0, the default timeout will be used.',
  ),
};
const includeSnapshotSchema = z.boolean().optional().describe(
  'Whether to include a snapshot in the response. Default is false.',
);
const uidSchema = z.string().describe(
  'The uid of an element on the page from the page content snapshot',
);

const browserContext = <T extends Record<string, unknown>>(
  params: T,
  ctx: TrustedBrowserSkillContext,
): T & { browserId: string; signal: AbortSignal } => ({
  ...params,
  browserId: ctx.browserId,
  signal: ctx.signal,
});
const files = (ctx: TrustedBrowserSkillContext) => ({
  cwd: ctx.workspace.dir,
  tempDir: ctx.workspace.tempDir,
  allowedRoots: [ctx.workspace.dir, ctx.workspace.tempDir],
});
const timeout = (value: number | undefined) => (
  value !== undefined && value <= 0 ? undefined : value
);

const skill = defineTrustedBrowserSkill({
  name: 'browser',
  domain: 'browser',
  functions: {
    list_pages: {
      description: 'Get a list of pages open in the browser.',
      params: z.object({}),
      async run(params, ctx) {
        return ok(await ctx.browser.core.list_pages(browserContext(params, ctx)));
      },
    },
    new_page: {
      description: 'Open a new tab and load a URL. Use project URL if not specified otherwise.',
      params: z.object({
        url: z.string().describe('URL to load in a new page.'),
        background: z.boolean().optional().describe(
          'Whether to open the page in the background without bringing it to the front. Default is false (foreground).',
        ),
        isolatedContext: z.string().optional().describe(
          'If specified, the page is created in an isolated browser context with the given name. '
          + 'Pages in the same browser context share cookies and storage. '
          + 'Pages in different browser contexts are fully isolated (useful for clean-slate testing of cookies and authentication).',
        ),
        ...timeoutSchema,
      }),
      async run(params, ctx) {
        const text = await ctx.browser.core.new_page(browserContext({
          ...params, timeout: timeout(params.timeout),
        }, ctx));
        ctx.browser.notifyPageOpen();
        return ok(text);
      },
    },
    select_page: {
      description: 'Select a page as a context for future tool calls.',
      params: z.object({
        pageId: z.number().describe('The ID of the page to select. Call list_pages to get available pages.'),
        bringToFront: z.boolean().optional().describe('Whether to focus the page and bring it to the top.'),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.select_page(browserContext(params, ctx)));
      },
    },
    close_page: {
      description: 'Closes the page by its ID. The last open page cannot be closed.',
      params: z.object({
        pageId: z.number().describe('The ID of the page to close. Call list_pages to list pages.'),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.close_page(browserContext(params, ctx)));
      },
    },
    navigate_page: {
      description: 'Go to a URL, or back, forward, or reload. Use project URL if not specified otherwise.',
      params: z.object({
        ...pageIdSchema,
        type: z.enum(['url', 'back', 'forward', 'reload']).optional().describe(
          'Navigate the page by URL, back or forward in history, or reload.',
        ),
        url: z.string().optional().describe('Target URL (only type=url)'),
        ignoreCache: z.boolean().optional().describe('Whether to ignore cache on reload.'),
        handleBeforeUnload: z.enum(['accept', 'dismiss']).optional().describe(
          'Whether to auto accept or beforeunload dialogs triggered by this navigation. Default is accept.',
        ),
        initScript: z.string().optional().describe(
          'A JavaScript script to be executed on each new document before any other scripts for the next navigation.',
        ),
        ...timeoutSchema,
      }),
      async run(params, ctx) {
        const text = await ctx.browser.core.navigate_page(browserContext({
          ...params, timeout: timeout(params.timeout),
        }, ctx));
        ctx.browser.notifyPageOpen();
        return ok(text);
      },
    },
    take_snapshot: {
      description: 'Take a text snapshot of the target page based on the a11y tree. The snapshot lists page elements along with a unique identifier (uid). Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot. The snapshot indicates the element selected in the DevTools Elements panel (if any).',
      params: z.object({
        ...pageIdSchema,
        verbose: z.boolean().optional().describe(
          'Whether to include all possible information available in the full a11y tree. Default is false.',
        ),
        filePath: z.string().optional().describe(
          'The absolute path, or a path relative to the current working directory, to save the snapshot to instead of attaching it to the response.',
        ),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.take_snapshot({ ...browserContext(params, ctx), files: files(ctx) }));
      },
    },
    click: {
      description: 'Clicks on the provided element',
      params: z.object({
        ...pageIdSchema,
        uid: uidSchema,
        dblClick: z.boolean().optional().describe('Set to true for double clicks. Default is false.'),
        includeSnapshot: includeSnapshotSchema,
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.click(browserContext(params, ctx)));
      },
    },
    hover: {
      description: 'Hover over the provided element',
      params: z.object({ ...pageIdSchema, uid: uidSchema, includeSnapshot: includeSnapshotSchema }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.hover(browserContext(params, ctx)));
      },
    },
    fill: {
      description: 'Type text into an input, text area or select an option from a <select> element.',
      params: z.object({
        ...pageIdSchema,
        uid: uidSchema,
        value: z.string().describe(
          'The value to fill in. "true" or "false" for checkboxes and toggles, "true" for radio buttons.',
        ),
        includeSnapshot: includeSnapshotSchema,
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.fill(browserContext(params, ctx)));
      },
    },
    fill_form: {
      description: 'Fill out multiple form elements (inputs, selects, checkboxes, radios) at once. Prefer this tool when the fields and values are known.',
      params: z.object({
        ...pageIdSchema,
        elements: z.array(z.object({
          uid: z.string().describe('The uid of the element to fill out'),
          value: z.string().describe(
            'Value for the element. "true" or "false" for checkboxes and toggles, "true" for radio buttons.',
          ),
        }).describe('An element to fill out')).describe('Elements from snapshot to fill out.'),
        includeSnapshot: includeSnapshotSchema,
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.fill_form(browserContext(params, ctx)));
      },
    },
    type_text: {
      description: 'Type text using keyboard into a previously focused input',
      params: z.object({
        ...pageIdSchema,
        text: z.string().describe('The text to type'),
        submitKey: z.string().optional().describe('Optional key to press after typing. E.g., "Enter", "Tab", "Escape"'),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.type_text(browserContext(params, ctx)));
      },
    },
    press_key: {
      description: 'Press a key or key combination. Use this when other input methods like fill() cannot be used (e.g., keyboard shortcuts, navigation keys, or special key combinations).',
      params: z.object({
        ...pageIdSchema,
        key: z.string().describe(
          'A key or a combination (e.g., "Enter", "Control+A", "Control++", "Control+Shift+R"). Modifiers: Control, Shift, Alt, Meta',
        ),
        includeSnapshot: includeSnapshotSchema,
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.press_key(browserContext(params, ctx)));
      },
    },
    drag: {
      description: 'Drag an element onto another element',
      params: z.object({
        ...pageIdSchema,
        from_uid: z.string().describe('The uid of the element to drag'),
        to_uid: z.string().describe('The uid of the element to drop into'),
        includeSnapshot: includeSnapshotSchema,
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.drag(browserContext(params, ctx)));
      },
    },
    upload_file: {
      description: 'Upload a file through a provided element. Files must be inside the workspace or task temporary directory.',
      params: z.object({
        ...pageIdSchema,
        uid: z.string().describe(
          'The uid of the file input element or an element that will open file chooser on the page from the page content snapshot',
        ),
        filePaths: z.array(z.string()).min(1).describe(
          'One or more files paths to upload. File paths have to be local to the browser instance (not the MCP).',
        ),
        includeSnapshot: includeSnapshotSchema,
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.upload_file({
          ...browserContext(params, ctx), allowedRoots: files(ctx).allowedRoots,
        }));
      },
    },
    wait_for: {
      description: 'Wait for the specified text to appear on the target page.',
      params: z.object({
        ...pageIdSchema,
        text: z.array(z.string()).min(1).describe(
          'Non-empty list of texts. Resolves when any value appears on the page.',
        ),
        ...timeoutSchema,
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.wait_for(browserContext({
          ...params, timeout: timeout(params.timeout),
        }, ctx)));
      },
    },
    handle_dialog: {
      description: 'If a browser dialog was opened, use this command to handle it',
      params: z.object({
        ...pageIdSchema,
        action: z.enum(['accept', 'dismiss']).describe('Whether to dismiss or accept the dialog'),
        promptText: z.string().optional().describe('Optional prompt text to enter into the dialog.'),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.handle_dialog(browserContext(params, ctx)));
      },
    },
    take_screenshot: {
      description: 'Take a screenshot of the page or element.',
      params: z.object({
        ...pageIdSchema,
        format: z.enum(['png', 'jpeg', 'webp']).default('png').describe(
          'Type of format to save the screenshot as. Default is "png"',
        ),
        quality: z.number().min(0).max(100).optional().describe(
          'Compression quality for JPEG and WebP formats (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format.',
        ),
        uid: z.string().optional().describe(
          'The uid of an element on the page from the page content snapshot. If omitted, takes a page screenshot.',
        ),
        fullPage: z.boolean().optional().describe(
          'If set to true takes a screenshot of the full page instead of the currently visible viewport. Incompatible with uid.',
        ),
        filePath: z.string().optional().describe(
          'The absolute path, or a path relative to the current working directory, to save the screenshot to instead of attaching it to the response.',
        ),
      }),
      async run(params, ctx) {
        const result = await ctx.browser.core.take_screenshot({ ...browserContext(params, ctx), files: files(ctx) });
        return ok(result.text, result.image ? {
          images: [{ base64: result.image.data, mediaType: result.image.mimeType }],
        } : undefined);
      },
    },
    evaluate_script: {
      description: 'Evaluate a JavaScript function inside the target page. Returns the response as JSON, so returned values have to be JSON-serializable.',
      params: z.object({
        ...pageIdSchema,
        function: z.string().describe(
          'A JavaScript function declaration to be executed by the tool in the target page.\n'
          + 'Example without arguments: `() => document.title` or `async () => await fetch("example.com")`.\n'
          + 'Example with arguments: `(el) => el.innerText`\n',
        ),
        args: z.array(uidSchema).optional().describe('An optional list of arguments to pass to the function.'),
        filePath: z.string().optional().describe(
          'The absolute or relative path to a file to save the script output to. If omitted, the output is returned inline.',
        ),
        dialogAction: z.string().optional().describe(
          'Handle dialogs while execution. "accept", "dismiss", or string for response of window.prompt. Defaults to accept.',
        ),
        waitForStableDom: z.boolean().optional().describe(
          'Whether to wait for the DOM to settle. Pass false if the script only reads data. Defaults to true.',
        ),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.evaluate_script({ ...browserContext(params, ctx), files: files(ctx) }));
      },
    },
    list_console_messages: {
      description: 'List all console messages for the target page since the last navigation.',
      params: z.object({
        ...pageIdSchema,
        pageSize: z.number().int().positive().optional().describe(
          'Maximum number of messages to return. When omitted, returns all messages.',
        ),
        pageIdx: z.number().int().min(0).optional().describe(
          'Page number to return (0-based). When omitted, returns the first page.',
        ),
        types: z.array(z.enum(CONSOLE_MESSAGE_TYPES)).optional().describe(
          'Filter messages to only return messages of the specified resource types. When omitted or empty, returns all messages.',
        ),
        includePreservedMessages: z.boolean().default(false).optional().describe(
          'Set to true to return the preserved messages over the last 3 navigations.',
        ),
        includeStackTraces: z.boolean().default(false).optional().describe(
          'Set to true to include the stack trace for each message when available. Increases the response size.',
        ),
        serviceWorkerId: z.string().optional().describe(
          'Filter messages to only return messages of the specified service worker.',
        ),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.list_console_messages({ ...browserContext(params, ctx), files: files(ctx) }));
      },
    },
    get_console_message: {
      description: 'Gets a console message by its ID. You can get all messages by calling list_console_messages.',
      params: z.object({
        ...pageIdSchema,
        msgid: z.number().describe('The msgid of a console message on the page from the listed console messages'),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.get_console_message({ ...browserContext(params, ctx), files: files(ctx) }));
      },
    },
    list_network_requests: {
      description: 'Lists the most recent requests for the target page since the last navigation.',
      params: z.object({
        ...pageIdSchema,
        pageSize: z.number().int().positive().optional().describe(
          'Maximum number of requests to return. When omitted, returns all requests.',
        ),
        pageIdx: z.number().int().min(0).optional().describe(
          'Page number to return (0-based). When omitted, returns the first page.',
        ),
        resourceTypes: z.array(z.enum(NETWORK_RESOURCE_TYPES)).optional().describe(
          'Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests.',
        ),
        includePreservedRequests: z.boolean().default(false).optional().describe(
          'Set to true to return the preserved requests over the last 3 navigations.',
        ),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.list_network_requests(browserContext(params, ctx)));
      },
    },
    get_network_request: {
      description: 'Gets a network request by an optional reqid, if omitted returns the currently selected request in the DevTools Network panel. Useful for inspecting request headers (including \'Cookie\') and response headers (including \'Set-Cookie\' and directives).',
      params: z.object({
        ...pageIdSchema,
        reqid: z.number().optional().describe(
          'The reqid of the network request. If omitted returns the currently selected request in the DevTools Network panel.',
        ),
        requestFilePath: z.string().optional().describe(
          'The absolute or relative path to a .network-request file to save the request body to. If omitted, the body is returned inline.',
        ),
        responseFilePath: z.string().optional().describe(
          'The absolute or relative path to a .network-response file to save the response body to. If omitted, the body is returned inline.',
        ),
      }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.get_network_request({ ...browserContext(params, ctx), files: files(ctx) }));
      },
    },
    closeBrowser: {
      description: 'Close the bound browser instance and its session.',
      params: z.object({}),
      async run(_params, ctx) {
        return ok(await ctx.browser.core.closeBrowser({ browserId: ctx.browserId }));
      },
    },
    getAllCookies: {
      description: 'Export all cookies (whole cookie store, including httpOnly) via CDP Network domain. Returns JSON { success, count, cookies }. The cookies array can be fed directly back to setCookies for account migration.',
      params: z.object({ urls: z.array(z.string()).optional().describe('Optional: only return cookies matching these URLs; omit to return the entire cookie store') }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.getAllCookies(browserContext(params, ctx)));
      },
    },
    setCookies: {
      description: 'Import cookies via CDP Network domain. Accepts a standard cookie JSON array (CDP CookieParam: name/value/domain/path/url/expires/httpOnly/secure/sameSite).',
      params: z.object({ cookies: z.array(z.looseObject({})).describe('Cookie objects to set (CDP CookieParam shape)') }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.setCookies(browserContext(params, ctx)));
      },
    },
    deleteCookies: {
      description: 'Delete specific cookies (one Network.deleteCookies per item). Each item needs a name and at least a url or domain to locate it.',
      params: z.object({ cookies: z.array(z.looseObject({})).describe('Cookies to delete; each item requires name plus url or domain') }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.deleteCookies(browserContext(params, ctx)));
      },
    },
    clearCookies: {
      description: 'Clear all cookies in the browser (Network.clearBrowserCookies).',
      params: z.object({}),
      async run(params, ctx) {
        return ok(await ctx.browser.core.clearCookies(browserContext(params, ctx)));
      },
    },
    getWindowBounds: {
      description: 'Read the browser window position/size/state. Returns JSON { success, bounds: { left, top, width, height, windowState } }.',
      params: z.object({}),
      async run(params, ctx) {
        return ok(await ctx.browser.core.getWindowBounds(browserContext(params, ctx)));
      },
    },
    setWindowBounds: {
      description: 'Set the browser window position/size/state (used for tiling). When geometry (left/top/width/height) is provided, the window is switched to normal state first. Returns JSON { success, bounds } with the actual bounds after applying.',
      params: z.object({ bounds: z.object({
        left: num().optional(), top: num().optional(), width: num().optional(), height: num().optional(),
        windowState: z.enum(['normal', 'minimized', 'maximized', 'fullscreen']).optional(),
      }).describe('Target window bounds') }),
      async run(params, ctx) {
        return ok(await ctx.browser.core.setWindowBounds(browserContext(params, ctx)));
      },
    },
  },
});

export default skill;
