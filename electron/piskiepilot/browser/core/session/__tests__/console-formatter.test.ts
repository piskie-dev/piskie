import { describe, expect, it, vi } from 'vitest';
import type { Protocol } from 'puppeteer-core';
import { ConsoleFormatter } from '../console-formatter.js';
import { UncaughtError } from '../page-collector.js';
import type { ConsoleDevToolsModel, ConsoleStackTrace } from '../console-stack.js';
import { consoleMessage } from './observation-fixtures.js';

const stack: ConsoleStackTrace = {
  syncFragment: { frames: [{ name: 'runFixture', url: 'https://fixture.test/source.js', line: 3, column: 7 }] },
  asyncFragments: [{ description: 'promise', frames: [{ name: 'nextFixture', url: 'https://fixture.test/async.js', line: 5, column: 2 }] }],
};
function model(): ConsoleDevToolsModel {
  return { stackTrace: vi.fn(async () => stack), cause: vi.fn(async () => undefined),
    exceptionDetails: vi.fn(async () => undefined), isIgnored: () => false, dispose: vi.fn() };
}

describe('fixed-source console formatting', () => {
  it('resolves arguments and uses the first argument as missing message text', async () => {
    const formatter = await ConsoleFormatter.from(consoleMessage('', { args: ['fixture', { value: 7 }] }), { id: 1, fetchDetailedData: true });
    expect(formatter.toJSONDetailed()).toMatchObject({ text: 'fixture', argsCount: 2, args: ['{"value":7}'] });
    expect(formatter.toStringDetailed()).toBe('ID: 1\nMessage: log> fixture\n### Arguments\nArg #0: {"value":7}');
  });
  it('groups only consecutive equal type/text/arg-count and keeps the first ID', async () => {
    const messages = await Promise.all([
      consoleMessage('repeat', { args: [1] }), consoleMessage('repeat', { args: [2] }),
      consoleMessage('repeat', { args: [2, 3] }), consoleMessage('separator'), consoleMessage('repeat', { args: [1] }),
    ].map((message, index) => ConsoleFormatter.from(message, { id: index + 1 })));
    const grouped = ConsoleFormatter.groupConsecutive(messages);
    expect(grouped).toHaveLength(4);
    expect(grouped[0].toString()).toBe('msgid=1 [log] repeat (1 args) [2 times]');
    expect(grouped[3].toJSON().id).toBe(5);
  });
  it('fetches available raw stacks, preserves grouped stacks, and adds the indexing note only to details', async () => {
    const devTools = model(); const raw = { callFrames: [] };
    const messages = await Promise.all([1, 2].map(id => ConsoleFormatter.from(consoleMessage('fixture', { rawStack: raw }), { id, fetchStackTrace: true, devTools })));
    const formatter = ConsoleFormatter.groupConsecutive(messages)[0];
    expect(devTools.stackTrace).toHaveBeenCalledWith(raw, 'fixture-target');
    expect(formatter.toString()).toContain('  at runFixture (https://fixture.test/source.js:3:7)');
    expect(formatter.toString()).toContain('--- promise ');
    expect(formatter.toString()).not.toContain('Note:');
    expect(formatter.toStringDetailed()).toContain('Note: line and column numbers use 1-based indexing');
  });
  it('formats uncaught remote error text and the available cause chain', async () => {
    const devTools = model();
    vi.mocked(devTools.cause).mockResolvedValueOnce({ type: 'object', subtype: 'error', objectId: 'fixture-cause', description: 'Error: cause\n    at x' });
    vi.mocked(devTools.exceptionDetails).mockResolvedValueOnce({ exceptionId: 2, text: 'cause', lineNumber: 0, columnNumber: 0, stackTrace: { callFrames: [] } });
    const formatter = await ConsoleFormatter.from(new UncaughtError({ exceptionId: 1, text: 'Uncaught', lineNumber: 0, columnNumber: 0,
      exception: { type: 'object', subtype: 'error', description: 'TypeError: fixture failure\n    at runFixture' }, stackTrace: { callFrames: [] },
    }, 'fixture-target'), { id: 8, fetchDetailedData: true, devTools });
    expect(formatter.toJSONDetailed().text).toBe('Uncaught TypeError: fixture failure');
    expect(formatter.toStringDetailed()).toContain('Caused by: cause');
  });
  it('caps stack output at 50 lines and omits ignored frames', async () => {
    const devTools = model();
    vi.mocked(devTools.stackTrace).mockResolvedValue({ syncFragment: { frames: Array.from({ length: 53 }, (_, line) => ({ name: `frame${line}`, line, column: 1 })) }, asyncFragments: [] });
    devTools.isIgnored = frame => frame.name === 'frame0';
    const formatter = await ConsoleFormatter.from(consoleMessage('fixture', { rawStack: { callFrames: [] } }), { id: 2, fetchDetailedData: true, devTools });
    expect(formatter.toStringDetailed()).not.toContain('at frame0\n');
    expect(formatter.toStringDetailed()).toContain('... and 2 more frames');
  });
  it('marks unavailable argument handles and preserves serialisation failures', async () => {
    const message = consoleMessage('fixture', { args: [7] });
    const handle = message.args()[0];
    vi.spyOn(message, 'args').mockReturnValue([handle]);
    vi.spyOn(handle, 'jsonValue').mockRejectedValue(new Error('fixture discarded'));
    const formatter = await ConsoleFormatter.from(message, { id: 4, fetchDetailedData: true });
    expect(formatter.toJSONDetailed().args).toEqual(['<error: Argument 0 is no longer available>']);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    const circularFormatter = await ConsoleFormatter.from(consoleMessage('fixture', { args: [circular] }), { id: 5, fetchDetailedData: true });
    expect(() => circularFormatter.toJSONDetailed()).toThrow();
  });
  it('does not fabricate a service-worker stack without a frontend model', async () => {
    const formatter = await ConsoleFormatter.from(new UncaughtError({ text: 'fixture worker failure' } as Protocol.Runtime.ExceptionDetails, 'fixture-extension'), { id: 3, fetchStackTrace: true });
    expect(formatter.toJSON()).toEqual({ id: 3, type: 'error', text: 'fixture worker failure', argsCount: 0 });
  });
});
