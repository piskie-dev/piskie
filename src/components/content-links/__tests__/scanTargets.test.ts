import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LinkedText } from '../ContentLinks';
import { scanContentTargets, targetFromHref, targetFromLinkHref } from '../scanTargets';

describe('content target scanner', () => {
  it('finds URLs and Unix paths throughout one text block', () => {
    const text = 'Open https://example.com/docs?q=1, then inspect /home/user/project/report.txt.';
    expect(scanContentTargets(text)).toEqual([
      {
        kind: 'url',
        value: 'https://example.com/docs?q=1',
        start: 5,
        end: 33,
      },
      {
        kind: 'path',
        value: '/home/user/project/report.txt',
        start: 48,
        end: 77,
      },
    ]);
  });

  it.each([
    '~/.sample/cache/items/',
    '~/.sample',
    '~/report.txt',
    '~/资料/报告.md',
    '~/资料/',
    '~/sample/final image.png',
  ])('preserves the full home-relative path and range: %s', (value) => {
    expect(scanContentTargets(value)).toEqual([
      { kind: 'path', value, start: 0, end: value.length },
    ]);
  });

  it('preserves a home-relative path between prose separators', () => {
    const value = '~/资料/报告.md';
    const prefix = '查看：“';
    const text = `${prefix}${value}”。`;
    expect(scanContentTargets(text)).toEqual([
      { kind: 'path', value, start: prefix.length, end: prefix.length + value.length },
    ]);
  });

  it('separates home-relative paths from adjacent paths and URLs', () => {
    const expected = [
      { kind: 'path', value: '/sample/docs/report.txt' },
      { kind: 'path', value: '~/.sample/cache/items/' },
      { kind: 'path', value: '~/资料/报告.md' },
      { kind: 'url', value: 'https://example.com/docs' },
      { kind: 'path', value: 'C:\\Sample\\report.txt' },
      { kind: 'path', value: '~/notes.txt' },
      { kind: 'path', value: '\\\\server\\share\\report.txt' },
      { kind: 'path', value: '~/.sample' },
      { kind: 'path', value: '/sample/docs/next.txt' },
    ];
    const text = expected.map(({ value }) => value).join(' ');
    let cursor = 0;
    const targets = expected.map((target) => {
      const start = cursor;
      const end = start + target.value.length;
      cursor = end + 1;
      return { ...target, start, end };
    });
    expect(scanContentTargets(text)).toEqual(targets);
  });

  it('stops filename continuation before a later home-relative path', () => {
    const text = '/sample/report.txt completed ~/notes.txt';
    expect(scanContentTargets(text)).toEqual([
      { kind: 'path', value: '/sample/report.txt', start: 0, end: 18 },
      { kind: 'path', value: '~/notes.txt', start: 29, end: text.length },
    ]);
  });

  it('keeps spaces inside Windows paths and cuts following CJK prose', () => {
    const [target] = scanContentTargets('C:\\Program Files\\Piskie\\report.txt 已完成');
    expect(target).toMatchObject({
      kind: 'path',
      value: 'C:\\Program Files\\Piskie\\report.txt',
    });
  });

  it('keeps a spaced CJK filename through its extension and cuts following prose', () => {
    const [target] = scanContentTargets(
      '18. /workspace/documents/2026 示例文档.md 后续说明',
    );
    expect(target).toMatchObject({
      kind: 'path',
      value: '/workspace/documents/2026 示例文档.md',
    });
  });

  it('ends a completed filename before ASCII metadata', () => {
    const [target] = scanContentTargets(
      '/tmp/example/final smoke.png 1.03 MB 2026-08-28T14:03:26.838Z',
    );
    expect(target).toMatchObject({
      kind: 'path',
      value: '/tmp/example/final smoke.png',
    });
  });

  it('keeps extension-like words inside a spaced filename until its final extension', () => {
    const [target] = scanContentTargets(
      '/workspace/documents/report.final copy.png completed',
    );
    expect(target).toMatchObject({
      kind: 'path',
      value: '/workspace/documents/report.final copy.png',
    });
  });

  it('keeps scanning when different targets share one line', () => {
    const targets = scanContentTargets(
      'C:\\Program Files\\Piskie\\report.txt https://example.com/docs /home/user/a.txt /home/user/b.txt',
    );
    expect(targets.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: 'path', value: 'C:\\Program Files\\Piskie\\report.txt' },
      { kind: 'url', value: 'https://example.com/docs' },
      { kind: 'path', value: '/home/user/a.txt' },
      { kind: 'path', value: '/home/user/b.txt' },
    ]);
  });

  it('returns Chinese sentence punctuation to the surrounding prose', () => {
    const targets = scanContentTargets(
      '访问 https://example.com/docs，再查看 /home/user/report.txt。',
    );
    expect(targets.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: 'url', value: 'https://example.com/docs' },
      { kind: 'path', value: '/home/user/report.txt' },
    ]);
  });

  it('recognizes UNC paths without treating fractions as files', () => {
    expect(scanContentTargets('ratio 3/4; file \\\\server\\share\\report.txt')).toEqual([
      expect.objectContaining({ kind: 'path', value: '\\\\server\\share\\report.txt' }),
    ]);
  });

  it.each([
    '处理步骤为采集/整理/展示。',
    '选择 café/menu/item。',
    '选择 cafe\u0301/menu/item。',
  ])('keeps slash-separated words as prose: %s', (text) => {
    expect(scanContentTargets(text)).toEqual([]);
  });

  it('recognizes Unicode absolute paths after prose separators', () => {
    const targets = scanContentTargets(
      '采集/整理/展示；查看：/sample/资料/说明.md。另见“/示例/文档.txt”。',
    );
    expect(targets.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: 'path', value: '/sample/资料/说明.md' },
      { kind: 'path', value: '/示例/文档.txt' },
    ]);
  });

  it('recognizes explicit web protocols immediately after CJK prose', () => {
    expect(scanContentTargets('访问https://example.com/docs。')).toEqual([
      expect.objectContaining({ kind: 'url', value: 'https://example.com/docs' }),
    ]);
  });

  it('does not stop scanning after the old length and match limits', () => {
    const urls = Array.from({ length: 350 }, (_, index) => `https://example.com/${index}`);
    const text = `${'x'.repeat(50_001)}\n${urls.join('\n')}`;
    const targets = scanContentTargets(text);
    expect(targets).toHaveLength(350);
    expect(targets.at(-1)?.value).toBe('https://example.com/349');
  });

  it('classifies explicit Markdown destinations without treating anchors as files', () => {
    expect(targetFromHref('https://example.com')).toEqual({ kind: 'url', value: 'https://example.com' });
    expect(targetFromHref('file:///home/user/a%20b.txt')).toEqual({ kind: 'path', value: '/home/user/a b.txt' });
    expect(targetFromHref('src/App.tsx')).toEqual({ kind: 'path', value: 'src/App.tsx' });
    expect(targetFromHref('#details')).toBeNull();
    expect(targetFromHref('mailto:user@example.com')).toBeNull();
  });

  it.each([
    ['/sample/src/example.ts:12', '/sample/src/example.ts'],
    ['/sample/src/example.ts:12:3', '/sample/src/example.ts'],
    ['/sample/src/Makefile:12', '/sample/src/Makefile'],
    ['~/sample/示例%20源码.ts:12:3', '~/sample/示例 源码.ts'],
    ['C:\\Sample\\src\\example.ts:12:3', 'C:\\Sample\\src\\example.ts'],
    ['C:/Sample/src/example.ts:12', 'C:/Sample/src/example.ts'],
    ['\\\\server\\share\\example.ts:12:3', '\\\\server\\share\\example.ts'],
    ['file:///sample/src/example%20file.ts:12', '/sample/src/example file.ts'],
    ['file:///C:/Sample/src/example.ts:12:3', 'C:/Sample/src/example.ts'],
    ['file://server/share/example.ts:12', '//server/share/example.ts'],
    ['/sample/src/example.ts%3A12%3A3', '/sample/src/example.ts'],
    ['/sample/100%/example.ts:12', '/sample/100%/example.ts'],
    ['/sample/cache:2026/example.ts:12', '/sample/cache:2026/example.ts'],
    ['src/example.ts:12', 'src/example.ts'],
  ])('resolves source locations in explicit local links: %s', (href, value) => {
    expect(targetFromLinkHref(href)).toEqual({ kind: 'path', value });
  });

  it.each([
    '/sample/src/example:notes.ts',
    '/sample/src/example.ts:latest',
    '/sample/src/example.ts:12.txt',
    '/sample/src/example.ts:12:3:4',
    '/sample/src/example.ts:0',
    '/sample/src/example.ts:12:0',
    '/sample/src/example.ts#L12',
    '/sample/src/example.ts:12/next.ts',
    '/sample/src/:12',
  ])('preserves local destinations without a complete source-location suffix: %s', (value) => {
    expect(targetFromLinkHref(value)).toEqual({ kind: 'path', value });
  });

  it.each([
    'https://example.com:8443/src/example.ts:12:3',
    'http://example.com:8080/12',
    'https://example.com/src/example.ts#L12:3',
    'https://example.com/src/example.ts?line=12:3',
  ])('preserves web URLs in explicit links: %s', (value) => {
    expect(targetFromLinkHref(value)).toEqual({ kind: 'url', value });
  });

  it.each(['#details:12', 'mailto:reader@example.com', 'ftp://example.com:21/src/example.ts:12'])
    ('keeps anchors and unsupported URL schemes out of local file actions: %s', (href) => {
      expect(targetFromLinkHref(href)).toBeNull();
    });

  it('keeps source-location parsing specific to link destinations', () => {
    expect(targetFromHref('/sample/images/example.png:12')).toEqual({
      kind: 'path', value: '/sample/images/example.png:12',
    });
    expect(targetFromHref('file:///sample/images/example.png:12:3')).toEqual({
      kind: 'path', value: '/sample/images/example.png:12:3',
    });
  });

  it('preserves home-relative explicit Markdown destinations', () => {
    expect(targetFromHref('~/.sample')).toEqual({ kind: 'path', value: '~/.sample' });
    expect(targetFromHref('~/资料/报告%20副本.md')).toEqual({ kind: 'path', value: '~/资料/报告 副本.md' });
  });

  it('renders every detected target as an interactive element', () => {
    const html = renderToStaticMarkup(
      createElement(LinkedText, null, 'https://example.com\n/home/user/report.txt'),
    );
    expect(html).toContain('data-content-target="url"');
    expect(html).toContain('data-content-target="path"');
  });

  it('renders targets beyond the old text and match limits', () => {
    const urls = Array.from({ length: 350 }, (_, index) => `https://example.com/${index}`);
    const html = renderToStaticMarkup(
      createElement(LinkedText, null, `${'x'.repeat(50_001)}\n${urls.join('\n')}`),
    );
    expect(html.match(/data-content-target="url"/g)).toHaveLength(350);
  });
});
