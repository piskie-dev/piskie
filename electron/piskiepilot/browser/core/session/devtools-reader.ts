/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/McpPage.ts
 * (getDevToolsPage and getDevToolsData). No browser or page owner is created.
 */

import type { Page } from 'puppeteer-core';

export interface DevToolsData {
  readonly cdpRequestId?: string;
  readonly cdpBackendNodeId?: number;
}

export async function getDevToolsPage(page: Page): Promise<Page | undefined> {
  try {
    return await page.hasDevTools() ? await page.openDevTools() : undefined;
  } catch {
    return undefined;
  }
}

export async function getDevToolsData(page: Page): Promise<DevToolsData> {
  try {
    const devtoolsPage = await getDevToolsPage(page);
    if (!devtoolsPage) return {};
    return await devtoolsPage.evaluate(async () => {
      // These are modules of the already-open Chrome DevTools frontend.
      // @ts-expect-error module belongs to the DevTools page, not the host
      const UI = await import('/bundled/ui/legacy/legacy.js');
      // @ts-expect-error module belongs to the DevTools page, not the host
      const SDK = await import('/bundled/core/sdk/sdk.js');
      const request = UI.Context.Context.instance().flavor(SDK.NetworkRequest.NetworkRequest);
      const node = UI.Context.Context.instance().flavor(SDK.DOMModel.DOMNode);
      return { cdpRequestId: request?.requestId(), cdpBackendNodeId: node?.backendNodeId() };
    });
  } catch {
    return {};
  }
}
