import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ConsoleMessage, Frame, HTTPRequest, Page } from 'puppeteer-core';
import { ConsoleCollector, NetworkCollector } from '../page-collector.js';

function fakePage() {
  const events = new EventEmitter();
  const mainFrame = {} as Frame;
  const page = Object.assign(events, {
    mainFrame: vi.fn(() => mainFrame),
  }) as unknown as Page;
  return { mainFrame, page };
}

function consoleMessage(text: string): ConsoleMessage {
  return {
    type: () => 'log',
    text: () => text,
    args: () => [],
  } as unknown as ConsoleMessage;
}

function request(
  url: string,
  frame: Frame,
  navigation: boolean,
): HTTPRequest {
  return {
    url: () => url,
    frame: () => frame,
    isNavigationRequest: () => navigation,
  } as unknown as HTTPRequest;
}

describe('ported page collectors', () => {
  it('assigns stable console IDs and preserves the latest three navigation buckets', () => {
    const current = fakePage();
    const collector = new ConsoleCollector(current.page);
    const first = consoleMessage('first');
    current.page.emit('console', first);
    current.page.emit('pageerror', 'primitive failure');

    expect(collector.getIdForResource(first)).toBe(1);
    expect(collector.getData()).toHaveLength(2);

    current.page.emit('framenavigated', current.mainFrame);
    const second = consoleMessage('second');
    current.page.emit('console', second);
    expect(collector.getData()).toEqual([second]);
    expect(collector.getData(true).map((item) => (
      item instanceof Error ? item.message : item.text()
    ))).toEqual(['first', 'primitive failure', 'second']);

    current.page.emit('framenavigated', current.mainFrame);
    current.page.emit('console', consoleMessage('third'));
    current.page.emit('framenavigated', current.mainFrame);
    current.page.emit('console', consoleMessage('fourth'));
    expect(collector.getData(true).map((item) => (
      item instanceof Error ? item.message : item.text()
    ))).toEqual(['second', 'third', 'fourth']);

    collector.dispose();
    expect(current.page.listenerCount('console')).toBe(0);
    expect(current.page.listenerCount('pageerror')).toBe(0);
    expect(current.page.listenerCount('framenavigated')).toBe(0);
  });

  it('keeps each main-document request in the navigation it starts', () => {
    const current = fakePage();
    const collector = new NetworkCollector(current.page);
    const firstDocument = request('https://example.test/one', current.mainFrame, true);
    const firstFetch = request('https://example.test/one/data', current.mainFrame, false);
    const secondDocument = request('https://example.test/two', current.mainFrame, true);

    current.page.emit('request', firstDocument);
    current.page.emit('framenavigated', current.mainFrame);
    current.page.emit('request', firstFetch);
    current.page.emit('request', secondDocument);
    current.page.emit('framenavigated', current.mainFrame);

    expect(collector.getData()).toEqual([secondDocument]);
    expect(collector.getData(true)).toEqual([firstDocument, firstFetch, secondDocument]);
    expect(collector.getIdForResource(firstDocument)).toBe(1);
    expect(collector.getIdForResource(secondDocument)).toBe(3);
    expect(collector.getById(2)).toBe(firstFetch);

    collector.dispose();
    expect(current.page.listenerCount('request')).toBe(0);
    expect(current.page.listenerCount('framenavigated')).toBe(0);
  });
});
