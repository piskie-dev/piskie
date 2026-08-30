import { describe, expect, it } from 'vitest';

import { messageText, rawText } from '../../presentationText';
import {
  isJsonLikeString,
  parseMaybeJson,
  toolParamsSummary,
  toolResultSummary,
} from '../toolSummary';

describe('isJsonLikeString', () => {
  it.each([
    [' {} ', {}],
    ['[1, 2]', [1, 2]],
    [' {"nested":[true, null]}\n', { nested: [true, null] }],
  ])('accepts a complete JSON container: %s', (input, parsed) => {
    expect(isJsonLikeString(input)).toBe(true);
    expect(parseMaybeJson(input)).toEqual(parsed);
  });

  it.each([
    '',
    'ordinary text',
    '{invalid}',
    '[1, 2',
    '{"a":1]',
    '{"a":1} trailing',
    '[1] trailing',
    '"x"',
    '1',
    'true',
    'null',
  ])('rejects non-container or invalid JSON: %s', (input) => {
    expect(isJsonLikeString(input)).toBe(false);
    expect(parseMaybeJson(input)).toBe(input);
  });

  it('rejects non-string values', () => {
    expect(isJsonLikeString({})).toBe(false);
    expect(isJsonLikeString([])).toBe(false);
    expect(isJsonLikeString(null)).toBe(false);
  });
});

describe('tool summary facts', () => {
  it('does not infer summaries from arbitrary object fields or array counts', () => {
    expect(toolParamsSummary({
      tool: 'unknown_tool',
      params: { message: 'guessed', name: 'also guessed', action: 'click', items: [1, 2] },
    })).toBeUndefined();
    expect(toolResultSummary({
      tool: 'unknown_tool',
      result: { summary: 'guessed', message: 'also guessed', action: 'click' },
    })).toBeUndefined();
    expect(toolResultSummary({ tool: 'unknown_tool', result: [{ name: 'guessed' }] }))
      .toBeUndefined();
  });

  it('uses explicit presenters for known tool inputs', () => {
    expect(toolParamsSummary({ tool: 'read', params: { file_path: '/tmp/raw.txt' } }))
      .toEqual(rawText('/tmp/raw.txt'));
    expect(toolParamsSummary({ tool: 'tool_search', params: { query: 'browser login' } }))
      .toEqual(messageText('transcript.summary.query', { query: rawText('browser login') }));
  });

  it('keeps explicit plain-text results raw and leaves structured results without a guess', () => {
    expect(toolResultSummary({ tool: 'unknown_tool', result: 'Provider output' }))
      .toEqual(rawText('Provider output'));
    expect(toolResultSummary({
      tool: 'unknown_tool',
      result: [{ type: 'text', text: 'Text block output' }],
    })).toEqual(rawText('Text block output'));
    expect(toolResultSummary({ tool: 'unknown_tool', result: { message: 'not generic text' } }))
      .toBeUndefined();
  });
});
