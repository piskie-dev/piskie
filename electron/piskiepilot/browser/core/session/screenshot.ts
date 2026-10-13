/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/tools/screenshot.ts.
 * Uses the default, unconfigured screenshot behavior with host file storage.
 */

import type { ElementHandle, Page } from 'puppeteer-core';
import {
  saveObservationFile,
  saveTemporaryObservationFile,
  validateObservationFile,
  type ObservationFileOptions,
} from './observation-files.js';

export type ScreenshotFormat = 'png' | 'jpeg' | 'webp';

export interface ScreenshotOptions {
  readonly format?: ScreenshotFormat;
  readonly quality?: number;
  readonly uid?: string;
  readonly fullPage?: boolean;
  readonly filePath?: string;
}

export interface ScreenshotDependencies {
  readonly resolveUid?: (uid: string, signal?: AbortSignal) => Promise<ElementHandle>;
  /** Borrowed handle; the caller retains ownership. */
  readonly element?: ElementHandle;
  readonly files: ObservationFileOptions;
  readonly signal?: AbortSignal;
}

export interface ScreenshotResult {
  readonly text: string;
  readonly image?: { readonly mimeType: string; readonly data: string };
  readonly filePath?: string;
}

/** The caller applies the page-scoped existing-dialog check before this helper. */
export async function takeScreenshot(
  page: Page,
  options: ScreenshotOptions,
  dependencies: ScreenshotDependencies,
): Promise<ScreenshotResult> {
  const format = options.format ?? 'png';
  const extension = `.${format}` as '.png' | '.jpeg' | '.webp';
  if (options.filePath) {
    await validateObservationFile(options.filePath, extension, dependencies.files);
  }
  if (options.uid && options.fullPage) {
    throw new Error('Providing both "uid" and "fullPage" is not allowed.');
  }
  dependencies.signal?.throwIfAborted();
  const element = options.uid
    ? dependencies.element ?? await dependencies.resolveUid!(options.uid, dependencies.signal)
    : undefined;
  try {
    dependencies.signal?.throwIfAborted();
    const quality = format === 'png' ? undefined : options.quality;
    const fullPage = options.fullPage ?? false;
    const screenshot = element
      ? await element.screenshot({ type: format, quality, optimizeForSpeed: true })
      : await page.screenshot({ type: format, fullPage, quality, optimizeForSpeed: true });
    const lines = [options.uid
      ? `Took a screenshot of node with uid "${options.uid}".`
      : fullPage
        ? 'Took a screenshot of the full current page.'
        : "Took a screenshot of the current page's viewport."];
    if (options.filePath) {
      const { filename } = await saveObservationFile(
        screenshot, options.filePath, extension, dependencies.files,
      );
      lines.push(`Saved screenshot to ${filename}.`);
      return { text: lines.join('\n'), filePath: filename };
    }
    if (screenshot.length >= 2_000_000) {
      const { filepath } = await saveTemporaryObservationFile(
        screenshot, `screenshot${extension}`, dependencies.files,
      );
      lines.push(`Saved screenshot to ${filepath}.`);
      return { text: lines.join('\n'), filePath: filepath };
    }
    return {
      text: lines.join('\n'),
      image: { mimeType: `image/${format}`, data: Buffer.from(screenshot).toString('base64') },
    };
  } finally {
    if (element && element !== dependencies.element) await element.dispose();
  }
}
