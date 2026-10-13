import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Browser, Target } from 'puppeteer-core';
import { ServiceWorkerConsoleCollector } from '../service-worker-console.js';
import { UncaughtError } from '../page-collector.js';
import { consoleMessage } from './observation-fixtures.js';

function target(url = 'chrome-extension://fixture-extension/worker.js', type = 'service_worker') {
  const session = Object.assign(new EventEmitter(), { send: vi.fn(async () => ({})), detach: vi.fn(async () => {}) });
  const worker = new EventEmitter();
  return { session, worker, target: { type: () => type, url: () => url,
    createCDPSession: vi.fn(async () => session), worker: vi.fn(async () => worker),
  } as unknown as Target };
}
function browser(targets: readonly Target[]) {
  return Object.assign(new EventEmitter(), { targets: () => [...targets] }) as unknown as Browser;
}

describe('fixed-source extension worker console owner', () => {
  it('collects console and Runtime exceptions under the extension ID, independently from page IDs', async () => {
    const current = target(); const host = browser([current.target]); const collector = new ServiceWorkerConsoleCollector(host);
    await collector.init(); const message = consoleMessage('fixture worker'); current.worker.emit('console', message);
    current.session.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'fixture exception' } });
    expect(current.session.send).toHaveBeenCalledWith('Runtime.enable');
    expect(collector.getIdForResource(message)).toBe(1);
    expect(collector.getData('fixture-extension')[1]).toBeInstanceOf(UncaughtError);
    expect(collector.getById('fixture-extension', 1)).toBe(message);
    expect(collector.getData('missing-extension')).toEqual([]);
    collector.dispose(); await collector.settled();
    expect(current.worker.listenerCount('console')).toBe(0);
    expect(current.session.listenerCount('Runtime.exceptionThrown')).toBe(0);
    expect(current.session.detach).toHaveBeenCalledOnce();
    expect(host.listenerCount('targetcreated')).toBe(0);
  });
  it('limits each extension to 1,000 logs while allocating IDs across the collector', async () => {
    const collector = new ServiceWorkerConsoleCollector();
    for (let index = 0; index < 1001; index++) collector.addLog('fixture-one', consoleMessage(String(index)));
    const other = consoleMessage('other'); collector.addLog('fixture-two', other);
    expect(collector.getData('fixture-one')).toHaveLength(1000);
    expect(collector.getIdForResource(collector.getData('fixture-one')[0])).toBe(2);
    expect(collector.getIdForResource(other)).toBe(1002);
    expect(() => collector.getById('missing', 1)).toThrow('No logs found for selected extension');
    expect(() => collector.getById('fixture-one', 1)).toThrow('Log not found for selected extension');
    expect(collector.find('fixture-two', message => collector.getIdForResource(message) === 1002)).toBe(other);
    collector.clearLogs('fixture-two'); expect(collector.getData('fixture-two')).toEqual([]);
  });
  it('ignores nonextension workers and follows created/destroyed targets without clearing preserved logs', async () => {
    const ordinary = target('https://fixture.test/worker.js'); const content = target('chrome-extension://fixture-extension/page.html', 'page');
    const host = browser([ordinary.target, content.target]); const collector = new ServiceWorkerConsoleCollector(host);
    await collector.init(); expect(ordinary.target.createCDPSession).not.toHaveBeenCalled();
    expect(content.target.createCDPSession).not.toHaveBeenCalled();
    const extension = target(); host.emit('targetcreated', extension.target); await collector.settled();
    extension.worker.emit('console', consoleMessage('preserved'));
    host.emit('targetdestroyed', extension.target); await collector.settled();
    expect(collector.getData('fixture-extension')).toHaveLength(1);
    expect(extension.session.detach).toHaveBeenCalledOnce(); collector.dispose();
  });
  it('detaches subscriptions whose CDP session arrives after browser teardown', async () => {
    const current = target(); let release!: (value: unknown) => void;
    vi.mocked(current.target.createCDPSession).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const collector = new ServiceWorkerConsoleCollector(browser([current.target]));
    const initializing = collector.init(); collector.dispose(); release(current.session);
    await initializing; await collector.settled();
    expect(current.session.detach).toHaveBeenCalledOnce();
    expect(current.worker.listenerCount('console')).toBe(0);
  });
});
