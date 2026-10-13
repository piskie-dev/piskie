/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/McpPage.ts (DevTools init/dispose),
 * src/McpContext.ts (loadResource), and src/devtools/DevtoolsUtils.ts.
 * A secondary observation session belongs to the existing page collector.
 */

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CDPSession, Page } from 'puppeteer-core';
import { createConsoleModel } from '../../third_party/devtools-frontend-61277fe/observation.js';
import type { ConsoleDevToolsModel } from './console-stack.js';
import { validatePathWithinRoots } from './file-roots.js';
import type { ObservationFileOptions } from './observation-files.js';

export class PageConsoleDevTools {
  readonly ready: Promise<void>;
  model?: ConsoleDevToolsModel;
  #session?: CDPSession;
  #disposed = false;
  #files?: ObservationFileOptions;

  constructor(page: Page) { this.ready = this.#init(page); }

  configureFiles(files: ObservationFileOptions): void { this.#files = files; }

  async #init(page: Page): Promise<void> {
    try {
      const session = await page.createCDPSession();
      this.#session = session;
      if (this.#disposed) { await session.detach(); return; }
      this.model = createConsoleModel(session, url => loadConsoleResource(url, this.#files));
    } catch {
      // Upstream treats unavailable optional DevTools metadata as best-effort.
      await this.#session?.detach().catch(() => undefined);
      this.#session = undefined;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.model?.dispose();
    this.model = undefined;
    void this.#session?.detach().catch(() => undefined);
    this.#session = undefined;
  }
}

export async function loadConsoleResource(urlString: string, files?: ObservationFileOptions): Promise<string> {
  const url = new URL(urlString);
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load resource: ${url}`);
    return response.text();
  }
  if (url.protocol === 'file:') {
    const filename = fileURLToPath(url);
    await validatePathWithinRoots(filename, files?.allowedRoots ?? []);
    return fs.readFile(filename, 'utf8');
  }
  throw new Error(`Unsupported protocol for: ${url}`);
}
