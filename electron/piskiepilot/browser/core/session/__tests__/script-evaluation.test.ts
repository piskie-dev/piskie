import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElementHandle, Frame, Page } from 'puppeteer-core';
import type { ActionReceipt } from '../action-waiter.js';
import { evaluateScript } from '../script-evaluation.js';
import { fileFixture } from './observation-fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function files() { const fixture = await fileFixture(); roots.push(fixture.root); return fixture; }
const receipt: ActionReceipt = { navigated: true, navigatedToUrl: 'https://fixture.test/next', domSettled: true, openedPageIds: [], closedPageIds: [] };
function evaluatable() {
  const realm: Record<string, unknown> = {};
  const fnDispose = vi.fn(async () => {});
  const page = {
    evaluateHandle: vi.fn(async (expression: string) => ({ value: vm.runInNewContext(expression, realm), dispose: fnDispose })),
    evaluate: vi.fn(async (fn, handle, ...args) => fn(handle.value, ...args.map(arg => arg.value))),
  } as unknown as Page;
  return { realm, page, fnDispose };
}
function waiter() {
  return vi.fn(async (action) => { await action(new AbortController().signal); return receipt; });
}
function element(frame: Frame, value: unknown): ElementHandle {
  return { frame, value, dispose: vi.fn(async () => {}) } as unknown as ElementHandle;
}

describe('fixed-source script evaluation', () => {
  it('runs async functions, serializes JSON in the page realm, and supplies default dialog/wait options', async () => {
    const { files } = await fileFixture(); roots.push(files.cwd);
    const current = evaluatable(); const waitForAction = waiter();
    const result = await evaluateScript(current.page, { function: 'async () => { globalThis.effect = 7; return await Promise.resolve({value: 9}); }' }, { files, waitForAction });
    expect(current.realm.effect).toBe(7);
    expect(result.text).toBe('Script ran on page and returned:\n```json\n{"value":9}\n```');
    expect(result.receipt).toBe(receipt);
    expect(waitForAction).toHaveBeenCalledOnce();
    expect(waitForAction.mock.calls[0][1]).toEqual({ handleDialog: 'accept', waitForStableDom: undefined, signal: undefined });
    expect(current.fnDispose).toHaveBeenCalledOnce();
  });
  it('prints and saves undefined literally and normalizes the file extension', async () => {
    const { root, files: storage } = await files(); const current = evaluatable(); const waitForAction = waiter();
    expect((await evaluateScript(current.page, { function: '() => undefined' }, { files: storage, waitForAction })).text).toContain('\nundefined\n');
    const result = await evaluateScript(current.page, { function: '() => undefined', filePath: 'output.data' }, { files: storage, waitForAction });
    expect(result.filePath).toBe(path.join(root, 'output.json'));
    expect(await fs.readFile(result.filePath!, 'utf8')).toBe('undefined');
    expect(result.text).toBe(`Script ran on page. Output saved to ${result.filePath}.`);
  });
  it('derives the frame from UID args and releases fresh handles while borrowing caller handles', async () => {
    const { files: storage } = await files(); const parent = evaluatable(); const child = evaluatable();
    const handle = element(child.page as unknown as Frame, { label: 'fixture label' });
    const resolveUid = vi.fn(async () => handle); const waitForAction = waiter();
    const result = await evaluateScript(parent.page, { function: '(el) => el.label', args: ['fixture_2'] }, { files: storage, waitForAction, resolveUid });
    expect(result.json).toBe('"fixture label"');
    expect(parent.page.evaluate).not.toHaveBeenCalled();
    expect(child.page.evaluate).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
    vi.mocked(handle.dispose).mockClear();
    await evaluateScript(parent.page, { function: '(el) => el.label', args: ['fixture_2'] }, { files: storage, waitForAction, elements: [handle] });
    expect(handle.dispose).not.toHaveBeenCalled();
  });
  it('rejects cross-frame args before the action and disposes every resolved handle', async () => {
    const { files: storage } = await files(); const current = evaluatable();
    const one = element({} as Frame, {}); const two = element({} as Frame, {}); const waitForAction = waiter();
    const resolveUid = vi.fn().mockResolvedValueOnce(one).mockResolvedValueOnce(two);
    await expect(evaluateScript(current.page, { function: '() => 1', args: ['fixture_1', 'fixture_2'] }, { files: storage, waitForAction, resolveUid })).rejects.toThrow("Elements from different frames can't be evaluated together.");
    expect(waitForAction).not.toHaveBeenCalled();
    expect(one.dispose).toHaveBeenCalledOnce(); expect(two.dispose).toHaveBeenCalledOnce();
  });
  it('forwards prompt/dismiss actions and false DOM waiting while still using the navigation waiter', async () => {
    const { files: storage } = await files(); const current = evaluatable(); const waitForAction = waiter();
    for (const dialogAction of ['dismiss', 'fixture prompt response']) {
      await evaluateScript(current.page, { function: '() => 1', dialogAction, waitForStableDom: false }, { files: storage, waitForAction });
      expect(waitForAction.mock.calls.at(-1)?.[1]).toMatchObject({ handleDialog: dialogAction, waitForStableDom: false });
    }
    expect(waitForAction).toHaveBeenCalledTimes(2);
  });
  it.each(['() => { globalThis.effect = 8; throw new Error("fixture exception"); }',
    '() => { globalThis.effect = 8; const data = {}; data.self = data; return data; }',
    '() => { globalThis.effect = 8; return 1n; }'])('propagates evaluation/serialization failures without rolling back page writes', async fn => {
    const { files: storage } = await files(); const current = evaluatable();
    await expect(evaluateScript(current.page, { function: fn }, { files: storage, waitForAction: waiter() })).rejects.toThrow();
    expect(current.realm.effect).toBe(8); expect(current.fnDispose).toHaveBeenCalledOnce();
  });
  it('validates files before evaluation and propagates post-action writes with their effects intact', async () => {
    const { root, files: storage } = await files(); const current = evaluatable();
    await expect(evaluateScript(current.page, { function: '() => 1', filePath: '../outside.json' }, { files: storage, waitForAction: waiter() })).rejects.toThrow('Access denied');
    expect(current.page.evaluateHandle).not.toHaveBeenCalled();
    await fs.mkdir(path.join(root, 'output.json'));
    await expect(evaluateScript(current.page, { function: '() => { globalThis.effect = 8; return 1; }', filePath: 'output.json' }, { files: storage, waitForAction: waiter() })).rejects.toThrow('Could not write');
    expect(current.realm.effect).toBe(8);
    await fs.mkdir(path.join(root, 'nested'));
    await fs.symlink(path.dirname(root), path.join(root, 'nested', 'output.json'));
    current.realm.effect = 0;
    await expect(evaluateScript(current.page, { function: '() => { globalThis.effect = 9; return 1; }', filePath: 'nested/output.data' }, { files: storage, waitForAction: waiter() })).rejects.toThrow('Access denied');
    expect(current.realm.effect).toBe(9);
  });
  it('releases earlier handles when a later UID fails and propagates cancellation', async () => {
    const { files: storage } = await files(); const current = evaluatable(); const handle = element({} as Frame, {});
    const resolveUid = vi.fn().mockResolvedValueOnce(handle).mockRejectedValueOnce(new Error('fixture UID missing'));
    await expect(evaluateScript(current.page, { function: '() => 1', args: ['fixture_1', 'fixture_2'] }, { files: storage, waitForAction: waiter(), resolveUid })).rejects.toThrow('fixture UID missing');
    expect(handle.dispose).toHaveBeenCalledOnce();
    const controller = new AbortController(); controller.abort(new Error('fixture cancelled'));
    await expect(evaluateScript(current.page, { function: '() => 1', args: ['fixture_1'] }, { files: storage, waitForAction: waiter(), resolveUid, signal: controller.signal })).rejects.toThrow('fixture cancelled');
  });
});
