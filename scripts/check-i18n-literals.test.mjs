import assert from 'node:assert/strict';
import test from 'node:test';

import { checkSource } from './check-i18n-literals.mjs';

test('rejects literal product copy in JSX and visible attributes', () => {
  const violations = checkSource(`
    const view = <button title="Delete">保存</button>;
  `);

  assert.deepEqual(violations.map((item) => item.kind), ['visible-attribute', 'jsx-text']);
});

test('accepts translated copy and dynamic external values', () => {
  const violations = checkSource(`
    const view = <button title={t('common.delete')}>{t('common.save')}{externalValue}</button>;
    rawText(error.message);
  `);

  assert.deepEqual(violations, []);
});

test('rejects copy hidden in presentation objects and JSX branches', () => {
  const violations = checkSource(`
    const item = { label: 'Save' };
    const emptyLabel = 'Nothing here';
    item.tooltip = 'Retry request';
    const view = <span>{ready ? 'Done' : 'Waiting'}</span>;
  `);

  assert.deepEqual(
    violations.map((item) => item.kind),
    [
      'presentation-field',
      'presentation-variable',
      'presentation-assignment',
      'jsx-expression',
      'jsx-expression',
    ],
  );
});

test('allows explicit brands, protocols, units, and path-like examples', () => {
  const violations = checkSource(`
    const view = <>
      <span>Piskie</span><span>HTTP</span><span>FPS</span>
      <input placeholder="https://example.com/api" />
      <input placeholder="proxy.example.com" />
    </>;
  `);

  assert.deepEqual(violations, []);
});

test('rejects literal rawText values but accepts an ignore with a reason', () => {
  const rejected = checkSource(`rawText('Operation failed');`, 'src/example.ts');
  assert.equal(rejected[0]?.kind, 'literal-raw-text');

  const ignored = checkSource(`
    // i18n-ignore -- upstream protocol sentinel
    const sentinel = '旧协议值';
  `, 'src/example.ts');
  assert.deepEqual(ignored, []);
});

test('requires ignore reasons and rejects stale ignores', () => {
  const malformed = checkSource(`
    // i18n-ignore
    const value = '旧值';
  `, 'src/example.ts');
  assert.ok(malformed.some((item) => item.kind === 'invalid-ignore'));
  assert.ok(malformed.some((item) => item.kind === 'cjk-literal'));

  const unused = checkSource(`
    // i18n-ignore -- no longer needed
    const value = 42;
  `, 'src/example.ts');
  assert.deepEqual(unused.map((item) => item.kind), ['unused-ignore']);
});

test('limits catalog exemptions to their declared data owner', () => {
  const source = `
    const SITE_NAMES = { 'example.com': '示例品牌' };
    const fallback = '保存失败';
  `;
  const violations = checkSource(source, 'src/features/envstudio/data/siteAtlas.ts');

  assert.deepEqual(violations.map((item) => item.text), ['保存失败']);
});
