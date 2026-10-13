import { describe, expect, it } from 'vitest';
import skill from '../skill.js';
import { toApiSchema } from '../../../../../tools/params.js';

const upstreamFunctions = [
  'list_pages', 'new_page', 'select_page', 'close_page', 'navigate_page',
  'take_snapshot', 'click', 'hover', 'fill', 'fill_form', 'type_text', 'press_key',
  'drag', 'upload_file', 'wait_for', 'handle_dialog', 'take_screenshot',
  'evaluate_script', 'list_console_messages', 'get_console_message',
  'list_network_requests', 'get_network_request',
] as const;
const hostFunctions = [
  'closeBrowser', 'getAllCookies', 'setCookies', 'deleteCookies', 'clearCookies',
  'getWindowBounds', 'setWindowBounds',
] as const;
const inputFunctions = ['click', 'hover', 'fill', 'fill_form', 'drag', 'upload_file', 'press_key'] as const;

const fields: Record<typeof upstreamFunctions[number], readonly string[]> = {
  list_pages: [],
  new_page: ['url', 'background', 'isolatedContext', 'timeout'],
  select_page: ['pageId', 'bringToFront'],
  close_page: ['pageId'],
  navigate_page: ['pageId', 'type', 'url', 'ignoreCache', 'handleBeforeUnload', 'initScript', 'timeout'],
  take_snapshot: ['pageId', 'verbose', 'filePath'],
  click: ['pageId', 'uid', 'dblClick', 'includeSnapshot'],
  hover: ['pageId', 'uid', 'includeSnapshot'],
  fill: ['pageId', 'uid', 'value', 'includeSnapshot'],
  fill_form: ['pageId', 'elements', 'includeSnapshot'],
  type_text: ['pageId', 'text', 'submitKey'],
  press_key: ['pageId', 'key', 'includeSnapshot'],
  drag: ['pageId', 'from_uid', 'to_uid', 'includeSnapshot'],
  upload_file: ['pageId', 'uid', 'filePaths', 'includeSnapshot'],
  wait_for: ['pageId', 'text', 'timeout'],
  handle_dialog: ['pageId', 'action', 'promptText'],
  take_screenshot: ['pageId', 'format', 'quality', 'uid', 'fullPage', 'filePath'],
  evaluate_script: ['pageId', 'function', 'args', 'filePath', 'dialogAction', 'waitForStableDom'],
  list_console_messages: ['pageId', 'pageSize', 'pageIdx', 'types', 'includePreservedMessages', 'includeStackTraces', 'serviceWorkerId'],
  get_console_message: ['pageId', 'msgid'],
  list_network_requests: ['pageId', 'pageSize', 'pageIdx', 'resourceTypes', 'includePreservedRequests'],
  get_network_request: ['pageId', 'reqid', 'requestFilePath', 'responseFilePath'],
};

describe('Chrome DevTools MCP 1.10.1 model schema', () => {
  it('publishes the 22 upstream tools and seven browser-level host functions in registration order', () => {
    expect(Object.keys(skill.functions)).toEqual([...upstreamFunctions, ...hostFunctions]);
  });

  it.each(upstreamFunctions)('%s exposes the fixed default-mode fields in source order', (name) => {
    const schema = toApiSchema(skill.functions[name].params);
    expect(Object.keys(schema.properties ?? {})).toEqual(fields[name]);
    if (name !== 'list_pages' && name !== 'new_page') {
      expect(schema.required).toContain('pageId');
      expect(schema.properties).toMatchObject({ pageId: { type: 'number' } });
    }
  });

  it.each(hostFunctions)('%s keeps its browser-level contract', (name) => {
    expect(toApiSchema(skill.functions[name].params).properties ?? {}).not.toHaveProperty('pageId');
  });

  it.each(inputFunctions)('%s leaves includeSnapshot optional with false behavior by default', (name) => {
    const schema = toApiSchema(skill.functions[name].params);
    expect(schema.properties).toMatchObject({ includeSnapshot: { type: 'boolean' } });
    expect(schema.required ?? []).not.toContain('includeSnapshot');
  });

  it('uses opaque UID strings and source form/upload/text-array boundaries', () => {
    expect(skill.functions.click.params.parse({ pageId: 7, uid: 'opaque-node' }))
      .toEqual({ pageId: 7, uid: 'opaque-node' });
    expect(skill.functions.fill_form.params.parse({ pageId: 7, elements: [] }))
      .toEqual({ pageId: 7, elements: [] });
    expect(skill.functions.upload_file.params.safeParse({ pageId: 7, uid: 'node', filePaths: [] }).success).toBe(false);
    expect(skill.functions.upload_file.params.parse({ pageId: 7, uid: 'node', filePaths: ['/workspace/a.txt', '/workspace/b.txt'] }))
      .toMatchObject({ filePaths: ['/workspace/a.txt', '/workspace/b.txt'] });
    expect(skill.functions.wait_for.params.safeParse({ pageId: 7, text: [] }).success).toBe(false);
    expect(skill.functions.wait_for.params.safeParse({ pageId: 7, text: 'Ready' }).success).toBe(false);
  });

  it('keeps source number/boolean types and integer-only optional timeouts without a local maximum', () => {
    expect(skill.functions.click.params.safeParse({ pageId: '7', uid: 'node' }).success).toBe(false);
    expect(skill.functions.click.params.safeParse({ pageId: 7, uid: 'node', dblClick: 'true' }).success).toBe(false);
    expect(skill.functions.close_page.params.parse({ pageId: 7.5 })).toEqual({ pageId: 7.5 });
    expect(skill.functions.new_page.params.safeParse({}).success).toBe(false);
    for (const timeout of [0, -1, 500_000]) {
      expect(skill.functions.new_page.params.parse({ url: 'about:blank', timeout })).toMatchObject({ timeout });
    }
    expect(skill.functions.wait_for.params.safeParse({ pageId: 7, text: ['Ready'], timeout: 0.5 }).success).toBe(false);
  });

  it('preserves screenshot and data defaults, enums and validation', () => {
    expect(skill.functions.take_screenshot.params.parse({ pageId: 7 })).toEqual({ pageId: 7, format: 'png' });
    expect(skill.functions.take_screenshot.params.safeParse({ pageId: 7, quality: 101 }).success).toBe(false);
    expect(skill.functions.take_screenshot.params.parse({ pageId: 7, quality: 50.5 })).toMatchObject({ quality: 50.5 });
    expect(skill.functions.list_console_messages.params.parse({ pageId: 7, types: ['issue'] })).toMatchObject({
      includePreservedMessages: false, includeStackTraces: false, types: ['issue'],
    });
    expect(skill.functions.list_network_requests.params.parse({ pageId: 7 })).toMatchObject({ includePreservedRequests: false });
    for (const name of ['list_console_messages', 'list_network_requests'] as const) {
      expect(skill.functions[name].params.safeParse({ pageId: 7, pageIdx: -1 }).success).toBe(false);
      expect(skill.functions[name].params.safeParse({ pageId: 7, pageSize: 0 }).success).toBe(false);
      expect(skill.functions[name].params.safeParse({ pageId: 7, pageSize: 1.5 }).success).toBe(false);
    }
  });
});
