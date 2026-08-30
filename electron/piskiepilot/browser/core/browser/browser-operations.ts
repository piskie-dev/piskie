/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Navigation behavior from chrome-devtools-mcp 1.7.0 was adapted to Piskie's
 * BrowserManager lock and structured host/runtime results.
 */

import type { CDPSession, Protocol } from 'puppeteer-core';
import { BrowserManager } from './browser-manager.js';
import type { ActionReceipt } from '../session/action-waiter.js';
import type { BrowserAutomationSession } from '../session/browser-automation-session.js';

export interface BrowserNavigateRequest {
  readonly browserId: string;
  readonly type?: 'url' | 'back' | 'forward' | 'reload';
  readonly url?: string;
  readonly ignoreCache?: boolean;
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

export interface BrowserPageObservation {
  readonly url: string;
  readonly title: string;
}

export interface BrowserNavigationResult extends BrowserPageObservation {
  readonly type: 'url' | 'back' | 'forward' | 'reload';
  readonly receipt: ActionReceipt;
  readonly error?: string;
}

export interface BrowserCookiesResult {
  readonly success: true;
  readonly count: number;
  readonly cookies: readonly Protocol.Network.Cookie[];
}

export interface BrowserWindowBoundsInput {
  readonly left?: number;
  readonly top?: number;
  readonly width?: number;
  readonly height?: number;
  readonly windowState?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
}

export class BrowserOperations {
  static navigate(request: BrowserNavigateRequest): Promise<BrowserNavigationResult> {
    const { browserId, signal, ...navigation } = request;
    return BrowserManager.runExclusive(
      browserId,
      ({ automation }) => this.navigateInSession(automation, navigation),
      signal
    );
  }

  static async navigateInSession(
    automation: BrowserAutomationSession,
    request: Omit<BrowserNavigateRequest, 'browserId' | 'signal'>
  ): Promise<BrowserNavigationResult> {
    const type = request.type ?? (request.url ? 'url' : undefined);
    if (!type) throw new Error('Either URL or a type is required.');

    const page = automation.getSelectedPage();
    const timeout = request.timeout && request.timeout <= 0 ? undefined : request.timeout;
    let navigationError: string | undefined;

    const receipt = await automation.waitForAction(async () => {
      switch (type) {
        case 'url':
          if (!request.url) {
            throw new Error('A URL is required for navigation of type=url.');
          }
          try {
            await page.goto(request.url!, { timeout });
          } catch (error) {
            navigationError = errorMessage(error);
          }
          break;
        case 'back':
          try {
            await page.goBack({ timeout });
          } catch (error) {
            navigationError = errorMessage(error);
          }
          break;
        case 'forward':
          try {
            await page.goForward({ timeout });
          } catch (error) {
            navigationError = errorMessage(error);
          }
          break;
        case 'reload':
          try {
            await page.reload({ timeout, ignoreCache: request.ignoreCache });
          } catch (error) {
            navigationError = errorMessage(error);
          }
          break;
      }
    }, {
      navigationTimeoutMs: timeout,
      handleDialog: { beforeunload: 'accept' },
    });

    if (receipt.dialog?.handled) automation.clearDialog();
    const selectedPage = automation.getSelectedPage();
    return {
      type,
      url: selectedPage.url(),
      title: await selectedPage.title(),
      receipt,
      ...(navigationError !== undefined ? { error: navigationError } : {}),
    };
  }

  static async getAllCookies(request: {
    browserId: string;
    urls?: readonly string[];
  }): Promise<BrowserCookiesResult> {
    return this.#withCdp(request.browserId, async (client) => {
      const result = request.urls?.length
        ? await client.send('Network.getCookies', { urls: [...request.urls] })
        : await client.send('Network.getAllCookies');
      return { success: true, count: result.cookies.length, cookies: result.cookies };
    });
  }

  static async setCookies(request: {
    browserId: string;
    cookies: readonly Record<string, unknown>[];
  }): Promise<Readonly<{ success: true; count: number }>> {
    return this.#withCdp(request.browserId, async (client) => {
      await client.send('Network.setCookies', {
        cookies: request.cookies as unknown as Protocol.Network.CookieParam[],
      });
      return { success: true, count: request.cookies.length };
    });
  }

  static async deleteCookies(request: {
    browserId: string;
    cookies: readonly Record<string, unknown>[];
  }): Promise<Readonly<{ success: true; count: number }>> {
    return this.#withCdp(request.browserId, async (client) => {
      for (const cookie of request.cookies) {
        await client.send(
          'Network.deleteCookies',
          cookie as unknown as Protocol.Network.DeleteCookiesRequest
        );
      }
      return { success: true, count: request.cookies.length };
    });
  }

  static async clearCookies(browserId: string): Promise<Readonly<{ success: true }>> {
    return this.#withCdp(browserId, async (client) => {
      await client.send('Network.clearBrowserCookies');
      return { success: true };
    });
  }

  static async getWindowBounds(browserId: string): Promise<Protocol.Browser.Bounds> {
    return this.#withWindow(browserId, async (client, windowId) => {
      const result = await client.send('Browser.getWindowBounds', { windowId });
      return result.bounds;
    });
  }

  static async setWindowBounds(
    browserId: string,
    bounds: BrowserWindowBoundsInput
  ): Promise<Protocol.Browser.Bounds> {
    return this.#withWindow(browserId, async (client, windowId) => {
      const geometry: Protocol.Browser.Bounds = {};
      for (const key of ['left', 'top', 'width', 'height'] as const) {
        const value = bounds[key];
        if (typeof value === 'number') geometry[key] = value;
      }
      if (Object.keys(geometry).length > 0) {
        await client.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'normal' },
        });
        await client.send('Browser.setWindowBounds', { windowId, bounds: geometry });
        if (bounds.windowState && bounds.windowState !== 'normal') {
          await client.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: bounds.windowState },
          });
        }
      } else if (bounds.windowState) {
        await client.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: bounds.windowState },
        });
      }
      const result = await client.send('Browser.getWindowBounds', { windowId });
      return result.bounds;
    });
  }

  static async captureJpeg(
    browserId: string,
    quality: number
  ): Promise<Readonly<{ data: string; timestamp: number }>> {
    return BrowserManager.runExclusive(browserId, async ({ automation }) => {
      const data = await automation.getSelectedPage().screenshot({
        type: 'jpeg',
        quality,
        encoding: 'base64',
      });
      return { data, timestamp: Date.now() };
    });
  }

  static close(browserId: string): Promise<void> {
    return BrowserManager.close(browserId);
  }

  static #withCdp<T>(browserId: string, action: (client: CDPSession) => Promise<T>): Promise<T> {
    return BrowserManager.runExclusive(browserId, async ({ automation }) => {
      const client = await automation.getSelectedPage().createCDPSession();
      try {
        await client.send('Network.enable');
        return await action(client);
      } finally {
        await client.detach().catch(() => undefined);
      }
    });
  }

  static #withWindow<T>(
    browserId: string,
    action: (client: CDPSession, windowId: number) => Promise<T>
  ): Promise<T> {
    return BrowserManager.runExclusive(browserId, async ({ automation }) => {
      const client = await automation.getSelectedPage().createCDPSession();
      try {
        const { windowId } = await client.send('Browser.getWindowForTarget');
        return await action(client, windowId);
      } finally {
        await client.detach().catch(() => undefined);
      }
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
