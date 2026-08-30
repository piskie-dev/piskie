import { describe, expect, it } from 'vitest';
import { resolveInitialAppLanguage } from '../app-language.js';

describe('resolveInitialAppLanguage', () => {
  it.each([
    ['zh-CN', 'zh-CN'],
    ['zh-Hant-TW', 'zh-CN'],
    ['en-GB', 'en-US'],
    ['fr-FR', 'en-US'],
  ] as const)('maps system language %s to %s', (systemLanguage, expected) => {
    expect(resolveInitialAppLanguage(systemLanguage)).toBe(expected);
  });
});
