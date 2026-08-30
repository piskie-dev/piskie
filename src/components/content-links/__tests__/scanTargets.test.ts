import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LinkedText } from '../ContentLinks';
import { scanContentTargets, targetFromHref } from '../scanTargets';

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
