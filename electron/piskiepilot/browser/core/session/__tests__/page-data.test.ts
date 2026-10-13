import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Issue, Page } from 'puppeteer-core';
import { ConsoleCollector, NetworkCollector } from '../page-collector.js';
import { getConsoleMessage, getNetworkRequest, listConsoleMessages, listNetworkRequests, resolveCdpRequestId } from '../page-data.js';
import { ServiceWorkerConsoleCollector } from '../service-worker-console.js';
import { consoleMessage, fakePage, fileFixture, request, response } from './observation-fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('fixed-source page data result helpers', () => {
  it('filters console types, groups before pagination, and gives ordinary invalid-page text', async () => {
    const current = fakePage(); const collector = new ConsoleCollector(current.page);
    for (const message of [consoleMessage('repeat'), consoleMessage('repeat'), consoleMessage('warn', { type: 'warn' }), consoleMessage('last')]) current.page.emit('console', message);
    expect((await listConsoleMessages(collector, { pageSize: 1, pageIdx: 1, types: ['log'] })).text).toBe('## Console messages\nShowing 2-2 of 2 (Page 2 of 2).\nPrevious page: 0\nmsgid=4 [log] last (0 args)');
    expect((await listConsoleMessages(collector, { pageSize: 1, pageIdx: 90 })).text).toContain('Invalid page number provided. Showing first page.\nShowing 1-1 of 3');
    expect((await listConsoleMessages(collector, { types: [] })).text).toContain('msgid=1 [log] repeat (0 args) [2 times]');
    expect((await listConsoleMessages(collector, { types: ['error'] })).text).toBe('## Console messages\n<no console messages found>');
    expect((await getConsoleMessage(collector, 1)).text).toBe('ID: 1\nMessage: log> repeat');
    await expect(getConsoleMessage(collector, 90)).rejects.toThrow('Request not found for selected page');
    expect(await getConsoleMessage(collector, 0)).toEqual({ text: '' });
    collector.dispose();
  });
  it('reads preserved data on demand and substitutes worker data using worker stable IDs', async () => {
    const current = fakePage(); const collector = new ConsoleCollector(current.page); const workers = new ServiceWorkerConsoleCollector();
    current.page.emit('console', consoleMessage('old page')); current.page.emit('framenavigated', current.mainFrame);
    current.page.emit('console', consoleMessage('current page'));
    workers.addLog('unused-extension', consoleMessage('unused worker')); workers.addLog('fixture-extension', consoleMessage('worker output'));
    expect((await listConsoleMessages(collector)).text).not.toContain('old page');
    expect((await listConsoleMessages(collector, { includePreservedMessages: true })).text).toContain('old page');
    expect((await listConsoleMessages(collector, { serviceWorkerId: 'fixture-extension' }, { serviceWorkers: workers })).text).toContain('msgid=2 [log] worker output');
    expect((await listConsoleMessages(collector, { serviceWorkerId: 'fixture-extension' }, { serviceWorkers: workers })).text).not.toContain('current page');
    expect((await listConsoleMessages(collector, { serviceWorkerId: 'missing' }, { serviceWorkers: workers })).text).toBe('## Console messages\n<no console messages found>');
    collector.dispose();
  });
  it('uses actual issue descriptions/details and resolves affected resources without losing protocol data', async () => {
    const current = fakePage(); const collector = new ConsoleCollector(current.page);
    current.page.emit('issue', { code: 'QuirksModeIssue', details: { quirksModeIssueDetails: {
      isLimitedQuirksMode: false, documentNodeId: 17, url: 'https://fixture.test/page', frameId: 'fixture-frame', loaderId: 'fixture-loader',
    } } } as Issue);
    expect((await listConsoleMessages(collector, { types: ['issue'] })).text).toContain('[issue]');
    const details = await getConsoleMessage(collector, 1, { elementIdResolver: id => id === 17 ? 'fixture_3' : undefined });
    expect(details.text).toContain('Learn more:'); expect(details.text).toContain('### Affected resources\nuid=fixture_3 data=');
    expect(details.text).not.toContain('documentNodeId'); expect(details.text).not.toContain('frameId');
    collector.dispose();
  });
  it('resolves CORS request IDs from actual issue details and keeps collected protocol data intact', async () => {
    const current = fakePage(); const collector = new ConsoleCollector(current.page);
    const details = { corsErrorStatus: { corsError: 'MissingAllowOriginHeader', failedParameter: 'fixture header' },
      isWarning: false, request: { requestId: 'fixture-cdp-request', url: 'https://fixture.test/resource' } };
    current.page.emit('issue', { code: 'CorsIssue', details: { corsIssueDetails: details } } as Issue);
    const result = await getConsoleMessage(collector, 1, { requestIdResolver: id => id === 'fixture-cdp-request' ? 7 : undefined });
    expect(result.text).toContain('reqid=7 data=');
    expect(result.text).not.toContain('"requestId"');
    expect(details.request.requestId).toBe('fixture-cdp-request');
    collector.dispose();
  });
  it('skips source-unformattable issue descriptions in lists and preserves the detail error', async () => {
    const current = fakePage(); const collector = new ConsoleCollector(current.page);
    current.page.emit('issue', { code: 'GenericIssue', details: { genericIssueDetails: {
      errorType: 'UnknownFutureFixtureReason', violatingNodeId: 23,
    } } } as unknown as Issue);
    expect((await listConsoleMessages(collector)).text).toBe('## Console messages\n<no console messages found>');
    await expect(getConsoleMessage(collector, 1)).rejects.toThrow("Can't provide details for the msgid 1");
    collector.dispose();
  });
  it('fetches requested console stacks and appends the source indexing note after list rows', async () => {
    const current = fakePage(); const collector = new ConsoleCollector(current.page);
    current.page.emit('console', consoleMessage('trace', { rawStack: { callFrames: [] } }));
    const devTools = { stackTrace: vi.fn(async () => ({ syncFragment: { frames: [{ name: 'fixture', line: 1, column: 1 }] }, asyncFragments: [] })),
      exceptionDetails: vi.fn(), cause: vi.fn(), isIgnored: () => false, dispose: vi.fn() };
    const result = await listConsoleMessages(collector, { includeStackTraces: true }, { devTools });
    expect(result.text).toContain('  at fixture\nNote: stack trace line and column numbers use 1-based indexing');
    expect(devTools.stackTrace).toHaveBeenCalledOnce(); collector.dispose();
  });
  it('filters network types, paginates, resolves the actual selected request and never substitutes a request', async () => {
    const current = fakePage(); const collector = new NetworkCollector(current.page);
    const first = request({ id: 'fixture-a', type: 'xhr' }); const second = request({ id: 'fixture-b', type: 'fetch', response: response('{}') });
    current.page.emit('request', first); current.page.emit('request', second);
    expect(resolveCdpRequestId(collector, 'fixture-b')).toBe(2);
    vi.mocked(current.page.hasDevTools).mockResolvedValue(true);
    vi.mocked(current.page.openDevTools).mockResolvedValue({ evaluate: async () => ({ cdpRequestId: 'fixture-b' }) } as unknown as Page);
    expect((await listNetworkRequests(current.page, collector, { resourceTypes: ['fetch'], pageSize: 1 })).text).toBe('## Network requests\nShowing 1-1 of 1 (Page 1 of 1).\nreqid=2 GET https://fixture.test/data [200] [selected in the DevTools Network panel]');
    expect((await getNetworkRequest(current.page, collector)).text).toContain('### Response Body\n{}');
    vi.mocked(current.page.openDevTools).mockResolvedValue({ evaluate: async () => ({ cdpRequestId: 'missing-request' }) } as unknown as Page);
    expect((await getNetworkRequest(current.page, collector)).text).toBe('Nothing is currently selected in the DevTools Network panel.');
    await expect(getNetworkRequest(current.page, collector, { reqid: 90 })).rejects.toThrow('Request not found for selected page');
    expect((await listNetworkRequests(current.page, collector, { resourceTypes: ['image'] })).text).toBe('## Network requests\nNo requests found.');
    expect((await listNetworkRequests(current.page, collector, { resourceTypes: [], pageSize: 1, pageIdx: 90 })).text).toContain('Invalid page number provided. Showing first page.');
    collector.dispose();
  });
  it('prechecks both network body filenames, writes actual bytes, and preserves distinct write-failure behavior', async () => {
    const { root, files } = await fileFixture(); roots.push(root); const current = fakePage(); const collector = new NetworkCollector(current.page);
    current.page.emit('request', request({ body: 'fixture request', response: response('fixture response') }));
    await expect(getNetworkRequest(current.page, collector, { reqid: 1, responseFilePath: '../outside' }, files)).rejects.toThrow('Access denied');
    const result = await getNetworkRequest(current.page, collector, { reqid: 1, requestFilePath: 'request.data', responseFilePath: 'response.data' }, files);
    expect(await fs.readFile(path.join(root, 'request.network-request'), 'utf8')).toBe('fixture request');
    expect(await fs.readFile(path.join(root, 'response.network-response'), 'utf8')).toBe('fixture response');
    expect(result.text).toContain('Saved to ');
    await fs.mkdir(path.join(root, 'blocked.network-response'));
    expect((await getNetworkRequest(current.page, collector, { reqid: 1, responseFilePath: 'blocked.network-response' }, files)).text).toContain('<Response body not available anymore>');
    await fs.mkdir(path.join(root, 'blocked.network-request'));
    await expect(getNetworkRequest(current.page, collector, { reqid: 1, requestFilePath: 'blocked.network-request' }, files)).rejects.toThrow('Could not write');
    collector.dispose();
  });
});
