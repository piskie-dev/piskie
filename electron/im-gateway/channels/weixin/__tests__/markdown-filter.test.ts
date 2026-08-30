import { describe, expect, it } from 'vitest';

import { StreamingMarkdownFilter } from '../vendor/src/messaging/markdown-filter.js';

function filter(input: string): string {
  const instance = new StreamingMarkdownFilter();
  return instance.feed(input) + instance.flush();
}

describe('Weixin 2.4.6 markdown filter', () => {
  it('preserves supported bold, inline code, fenced code, tables and rules', () => {
    expect(filter('**bold**')).toBe('**bold**');
    expect(filter('use `const x = 1` now')).toBe('use `const x = 1` now');
    expect(filter('```js\nconst x = 1;\n```')).toBe('```js\nconst x = 1;\n```');
    expect(filter('| A | B |\n|---|---|\n| 1 | 2 |')).toBe('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(filter('---')).toBe('---');
  });

  it('removes unsupported CJK italic markers without dropping text', () => {
    expect(filter('中文 *斜体* test')).toBe('中文 斜体 test');
  });
});
