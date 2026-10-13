/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/utils/url.ts (isAllowedUrl),
 * with the fixed default categoryExtensions=false contract.
 */

/** Default source URL policy shared by page tracking and navigation validation. */
export function isAllowedUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return false; }

  if (parsed.protocol === 'chrome:') {
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host === 'newtab' || host === 'new-tab-page' || host === 'inspect') return true;
    if (host === '' && (path === 'newtab' || path === 'new-tab-page' || path.startsWith('inspect'))) return true;
  }
  if (parsed.protocol === 'chrome:' || parsed.protocol === 'chrome-untrusted:') return false;
  if (parsed.protocol === 'chrome-extension:') return false;
  return true;
}
