import { describe, expect, it } from 'vitest';
import { isAllowedUrl } from '../url.js';

describe('fixed default page and navigation URL policy', () => {
  it.each([
    'http://example.test/sample',
    'https://example.test/sample',
    'file:///workspace/sample.html',
    'about:blank',
    'about:srcdoc',
    'data:text/html,Sample%20page',
    'javascript:void(0)',
    'chrome-error://chromewebdata/',
    'chrome://newtab/',
    'chrome://new-tab-page/',
    'chrome://inspect/#devices',
    'chrome:newtab',
    'chrome:new-tab-page',
    'chrome:inspect-devices',
    'CHROME://INSPECT/devices',
    'devtools://devtools/bundled/inspector.html',
  ])('preserves the source allow result for %s', (url) => {
    expect(isAllowedUrl(url)).toBe(true);
  });

  it.each([
    'chrome://settings/',
    'chrome://extensions/',
    'chrome://version/',
    'chrome:settings',
    'chrome-untrusted://new-tab-page/',
    'chrome-extension://sample-extension/page.html',
    '',
    '/sample.html',
    'sample relative url',
  ])('preserves the source reject result for %s', (url) => {
    expect(isAllowedUrl(url)).toBe(false);
  });
});
