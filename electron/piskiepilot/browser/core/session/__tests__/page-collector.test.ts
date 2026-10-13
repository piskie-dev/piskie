import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Frame, Issue } from 'puppeteer-core';
import { FrameEvent } from 'puppeteer-core/internal/api/Frame.js';
import { ConsoleCollector, ConsoleIssue, NetworkCollector, UncaughtError } from '../page-collector.js';
import { consoleMessage, fakePage, request } from './observation-fixtures.js';

function quirksIssue(node: number): Issue {
  return { code: 'QuirksModeIssue', details: { quirksModeIssueDetails: {
    isLimitedQuirksMode: false, documentNodeId: node, url: 'https://fixture.test/page',
    frameId: 'fixture-frame', loaderId: 'fixture-loader',
  } } } as Issue;
}

describe('fixed-source page collectors', () => {
  it('assigns stable IDs and preserves the latest three navigation buckets oldest-first', () => {
    const current = fakePage();
    const collector = new ConsoleCollector(current.page);
    const first = consoleMessage('first');
    current.page.emit('console', first);
    current.client.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'fixture failure' } });
    expect(collector.getIdForResource(first)).toBe(1);
    expect(collector.getData()[1]).toBeInstanceOf(UncaughtError);
    for (const text of ['second', 'third', 'fourth']) {
      current.page.emit('framenavigated', current.mainFrame);
      current.page.emit('console', consoleMessage(text));
    }
    expect(collector.getData(true).map(item => 'text' in item ? item.text() : '')).toEqual(['second', 'third', 'fourth']);
    expect(() => collector.getById(1)).toThrow('Request not found for selected page');
    expect(collector.getById(5)).toBe(collector.getData()[0]);
    collector.dispose();
    expect(current.page.listenerCount('console')).toBe(0);
    expect(current.page.listenerCount('issue')).toBe(0);
    expect(current.page.listenerCount('framenavigated')).toBe(0);
    expect(current.mainFrame.listenerCount(FrameEvent.FrameNavigatedWithinDocument)).toBe(0);
    expect(current.client.listenerCount('Runtime.exceptionThrown')).toBe(0);
  });

  it('preserves same-document/subframe data and reattaches to a replaced main frame', () => {
    const current = fakePage();
    const collector = new ConsoleCollector(current.page);
    const first = consoleMessage('first'); current.page.emit('console', first);
    current.mainFrame.emit(FrameEvent.FrameNavigatedWithinDocument, undefined);
    current.page.emit('framenavigated', current.mainFrame);
    current.page.emit('framenavigated', new EventEmitter() as unknown as Frame);
    expect(collector.getData()).toEqual([first]);
    const originalFrame = current.mainFrame;
    current.setMainFrame(new EventEmitter() as unknown as Frame);
    current.page.emit('framenavigated', current.mainFrame);
    expect(collector.getData()).toEqual([]);
    expect(originalFrame.listenerCount(FrameEvent.FrameNavigatedWithinDocument)).toBe(0);
    const second = consoleMessage('second'); current.page.emit('console', second);
    current.mainFrame.emit(FrameEvent.FrameNavigatedWithinDocument, undefined);
    current.page.emit('framenavigated', current.mainFrame);
    expect(collector.getData()).toEqual([second]);
    collector.dispose();
  });

  it('keeps each main-document request with its navigation and stable ID', () => {
    const current = fakePage();
    const collector = new NetworkCollector(current.page);
    const first = request({ url: 'https://fixture.test/one', frame: current.mainFrame, navigation: true });
    const fetch = request({ frame: current.mainFrame });
    const second = request({ url: 'https://fixture.test/two', frame: current.mainFrame, navigation: true });
    current.page.emit('request', first); current.page.emit('framenavigated', current.mainFrame);
    current.page.emit('request', fetch);
    current.mainFrame.emit(FrameEvent.FrameNavigatedWithinDocument, undefined);
    current.page.emit('framenavigated', current.mainFrame);
    expect(collector.getData()).toEqual([first, fetch]);
    current.page.emit('request', second); current.page.emit('framenavigated', current.mainFrame);
    expect(collector.getData()).toEqual([second]);
    expect(collector.getData(true)).toEqual([first, fetch, second]);
    expect(collector.getIdForResource(second)).toBe(3);
    expect(collector.getById(2)).toBe(fetch);
    collector.dispose();
  });

  it('enforces 10,000 console and 1,000 network records per navigation', () => {
    const current = fakePage();
    const consoleCollector = new ConsoleCollector(current.page);
    const networkCollector = new NetworkCollector(current.page);
    for (let index = 0; index < 10_002; index++) current.page.emit('console', consoleMessage(String(index)));
    for (let index = 0; index < 1_002; index++) current.page.emit('request', request());
    expect(consoleCollector.getData()).toHaveLength(10_000);
    expect(consoleCollector.getIdForResource(consoleCollector.getData()[0])).toBe(3);
    expect(networkCollector.getData()).toHaveLength(1_000);
    expect(networkCollector.getIdForResource(networkCollector.getData()[0])).toBe(3);
    consoleCollector.dispose(); networkCollector.dispose();
  });

  it('uses the actual pinned issue mapping, deduplication, aggregation and navigation reset', () => {
    const current = fakePage(); const collector = new ConsoleCollector(current.page);
    current.page.emit('issue', quirksIssue(1)); current.page.emit('issue', quirksIssue(1));
    current.page.emit('issue', quirksIssue(2));
    const issue = collector.getData()[0] as ConsoleIssue;
    expect(collector.getData()).toHaveLength(1);
    expect(issue).toBeInstanceOf(ConsoleIssue);
    expect(issue.getAggregatedIssuesCount()).toBe(2);
    current.mainFrame.emit(FrameEvent.FrameNavigatedWithinDocument, undefined);
    current.page.emit('framenavigated', current.mainFrame);
    current.page.emit('issue', quirksIssue(3));
    expect(issue.getAggregatedIssuesCount()).toBe(3);
    current.page.emit('framenavigated', current.mainFrame);
    current.page.emit('issue', quirksIssue(1));
    expect(collector.getData()).toHaveLength(1);
    expect(collector.getData()[0]).not.toBe(issue);
    expect(collector.getById(1)).toBe(issue);
    collector.dispose();
  });
});
