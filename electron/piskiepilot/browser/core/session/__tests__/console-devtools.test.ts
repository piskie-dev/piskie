import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CDPSession, Page, Protocol } from 'puppeteer-core';
import { PageConsoleDevTools, loadConsoleResource } from '../console-devtools.js';
import { ConsoleFormatter } from '../console-formatter.js';
import { fileFixture } from './observation-fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

class FixtureSession extends EventEmitter {
  detach = vi.fn(async () => {});
  id() { return 'fixture-session'; }
  connection() { return { session: (id: string) => id === this.id() ? this : undefined }; }
  async send(method: string) {
    if (method === 'Debugger.enable') return { debuggerId: 'fixture-debugger' };
    if (method === 'Page.getResourceTree') return { frameTree: { frame: { id: 'fixture-frame', url: 'https://fixture.test/page', loaderId: 'fixture-loader', securityOrigin: 'https://fixture.test', mimeType: 'text/html' }, resources: [] } };
    if (method === 'Runtime.getIsolateId') return { id: 'fixture-isolate' };
    if (method === 'Runtime.getProperties') return { result: [] };
    if (method === 'Debugger.getScriptSource') return { scriptSource: 'function fixture(){return 1;}' };
    return {};
  }
  override emit(type: string | symbol, payload: unknown): boolean {
    super.emit(type, payload); if (type !== '*') super.emit('*', type, payload); return true;
  }
}
function sourceMap(original: string) {
  return 'data:application/json;base64,' + Buffer.from(JSON.stringify({ version: 3, sources: [original], names: [], mappings: 'AAAA', sourcesContent: ['function fixture(){return 1;}'] })).toString('base64');
}
function parsedScript(map: string) {
  return { scriptId: 'fixture-script', url: 'https://fixture.test/bundle.js', startLine: 0, startColumn: 0, endLine: 4, endColumn: 0, executionContextId: 1, hash: 'fixture-hash', sourceMapURL: map };
}
const raw: Protocol.Runtime.StackTrace = { callFrames: [{ functionName: 'fixture', scriptId: 'fixture-script', url: 'https://fixture.test/bundle.js', lineNumber: 0, columnNumber: 0 }] };

describe('pinned frontend console observations', () => {
  it('initializes real Node frontend models, maps inline sources, and releases transport listeners', async () => {
    const session = new FixtureSession(); const page = { createCDPSession: async () => session } as unknown as Page;
    const owner = new PageConsoleDevTools(page); await owner.ready; expect(owner.model).toBeDefined();
    session.emit('Debugger.scriptParsed', parsedScript(sourceMap('https://fixture.test/original.js')));
    const stack = await owner.model!.stackTrace(raw, 'fixture-target');
    expect(stack.syncFragment.frames[0].uiSourceCode?.uiLocation(0, 0).linkText(false, true)).toBe('original.js:1:1');
    const message = { type: () => 'log', text: () => 'fixture stack', args: () => [], _rawStackTrace: () => raw, _targetId: () => 'fixture-target' };
    const formatted = await ConsoleFormatter.from(message as never, { id: 1, fetchStackTrace: true, devTools: owner.model });
    expect(formatted.toString()).toContain('(original.js:1:1)');
    owner.dispose(); expect(session.eventNames()).toEqual([]); expect(session.detach).toHaveBeenCalledOnce();
  });
  it('applies each page owner file boundary to file source-map resources', async () => {
    const { root, files } = await fileFixture(); roots.push(root);
    const filename = path.join(root, 'source-map.json');
    await fs.writeFile(filename, JSON.stringify({ version: 3, sources: ['https://fixture.test/file-original.js'], names: [], mappings: 'AAAA', sourcesContent: ['function fixture(){return 1;}'] }));
    const session = new FixtureSession(); const owner = new PageConsoleDevTools({ createCDPSession: async () => session } as unknown as Page);
    owner.configureFiles(files); await owner.ready;
    session.emit('Debugger.scriptParsed', parsedScript(pathToFileURL(filename).href));
    const stack = await owner.model!.stackTrace(raw);
    expect(stack.syncFragment.frames[0].uiSourceCode?.uiLocation(0, 0).linkText(false, true)).toBe('file-original.js:1:1');
    owner.dispose();
    await expect(loadConsoleResource(pathToFileURL(filename).href)).rejects.toThrow('Access denied');
    expect(await loadConsoleResource(pathToFileURL(filename).href, files)).toContain('file-original.js');
  });
  it('detaches delayed secondary sessions after owner disposal and tolerates unavailable metadata', async () => {
    const session = new FixtureSession(); let release!: (session: CDPSession) => void;
    const owner = new PageConsoleDevTools({ createCDPSession: () => new Promise<CDPSession>(resolve => { release = resolve; }) } as unknown as Page);
    owner.dispose(); release(session as unknown as CDPSession); await owner.ready;
    expect(session.detach).toHaveBeenCalledOnce(); expect(owner.model).toBeUndefined();
    const unavailable = new PageConsoleDevTools({ createCDPSession: async () => { throw new Error('fixture closed'); } } as unknown as Page);
    await unavailable.ready; expect(unavailable.model).toBeUndefined(); unavailable.dispose();
  });
});
