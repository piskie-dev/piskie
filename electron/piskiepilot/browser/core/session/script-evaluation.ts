/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/tools/script.ts (page branch).
 * Page routing and action waiting are supplied by the existing session owner.
 */

import type { ElementHandle, Frame, Page } from 'puppeteer-core';
import type { ActionReceipt } from './action-waiter.js';
import {
  saveObservationFile,
  validateObservationFile,
  type ObservationFileOptions,
} from './observation-files.js';

export interface ScriptEvaluationOptions {
  readonly function: string;
  readonly args?: readonly string[];
  readonly filePath?: string;
  readonly dialogAction?: string;
  readonly waitForStableDom?: boolean;
}

export interface ScriptEvaluationDependencies {
  readonly resolveUid?: (uid: string, signal?: AbortSignal) => Promise<ElementHandle>;
  /** Borrowed handles in the same order as args; the caller retains ownership. */
  readonly elements?: readonly ElementHandle[];
  readonly waitForAction: (
    action: (signal: AbortSignal) => Promise<unknown>,
    options: { handleDialog: string; waitForStableDom?: boolean; signal?: AbortSignal },
  ) => Promise<ActionReceipt>;
  readonly files: ObservationFileOptions;
  readonly signal?: AbortSignal;
}

export interface ScriptEvaluationResult {
  readonly text: string;
  readonly json: string | undefined;
  readonly filePath?: string;
  readonly receipt: ActionReceipt;
}

/** Like the upstream defineTool handler, this performs no existing-dialog precheck. */
export async function evaluateScript(
  page: Page,
  options: ScriptEvaluationOptions,
  dependencies: ScriptEvaluationDependencies,
): Promise<ScriptEvaluationResult> {
  if (options.filePath) {
    await validateObservationFile(options.filePath, '.json', dependencies.files);
  }
  const handles: ElementHandle[] = [];
  try {
    for (const [index, uid] of (options.args ?? []).entries()) {
      dependencies.signal?.throwIfAborted();
      handles.push(dependencies.elements?.[index]
        ?? await dependencies.resolveUid!(uid, dependencies.signal));
    }
    const frames = new Set<Frame>(handles.map(handle => handle.frame));
    if (frames.size > 1) {
      throw new Error("Elements from different frames can't be evaluated together.");
    }
    const evaluatable = [...frames][0] ?? page;
    let json: string | undefined;
    let filePath: string | undefined;
    let text = '';
    const receipt = await dependencies.waitForAction(async (signal) => {
      signal.throwIfAborted();
      const fn = await evaluatable.evaluateHandle(`(${options.function})`);
      try {
        signal.throwIfAborted();
        json = await evaluatable.evaluate(async (fn, ...args) => {
          // The declared function is deliberately evaluated in the page/frame realm.
          return JSON.stringify(await (fn as (...args: unknown[]) => unknown)(...args));
        }, fn, ...handles);
        if (options.filePath) {
          const { filename } = await saveObservationFile(
            new TextEncoder().encode(json ?? 'undefined'),
            options.filePath, '.json', dependencies.files,
          );
          filePath = filename;
          text = `Script ran on page. Output saved to ${filename}.`;
        } else {
          text = ['Script ran on page and returned:', '```json', `${json}`, '```'].join('\n');
        }
      } finally {
        await fn.dispose();
      }
    }, {
      handleDialog: options.dialogAction ?? 'accept',
      waitForStableDom: options.waitForStableDom,
      signal: dependencies.signal,
    });
    return { text, json, filePath, receipt };
  } finally {
    await Promise.all(handles.filter(handle => !dependencies.elements?.includes(handle))
      .map(handle => handle.dispose()));
  }
}
