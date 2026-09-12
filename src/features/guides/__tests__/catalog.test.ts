import { describe, expect, it } from 'vitest';
import zh from '../../../i18n/locales/guides.zh-CN';
import en from '../../../i18n/locales/guides.en-US';
import { GUIDE_IDS, GUIDE_ICONS } from '../catalog';

function keys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}.${key}`)).sort();
}

describe('business guide catalog', () => {
  it('has matching translations and a complete entry for every guide', () => {
    expect(keys(zh)).toEqual(keys(en));
    expect(Object.keys(zh.items)).toEqual([...GUIDE_IDS]);
    for (const id of GUIDE_IDS) {
      expect(GUIDE_ICONS[id]).toBeDefined();
      expect(en.items[id].title.length).toBeGreaterThan(0);
      expect(zh.items[id].summary.length).toBeGreaterThan(0);
      if (id !== 'getting-started') {
        expect(en.workflows[id].screen0.length).toBeGreaterThan(0);
        expect(en.workflows[id].screen1.length).toBeGreaterThan(0);
        expect(en.workflows[id].screen2.length).toBeGreaterThan(0);
      }
    }
  });
});
