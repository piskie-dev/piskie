/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.7.0
 * src/formatters/NetworkFormatter.ts. File-writing body options, DevTools UI
 * selection, and bundled DevTools header formatting were removed.
 */

import { isUtf8 } from 'node:buffer';
import type { HTTPRequest, HTTPResponse } from 'puppeteer-core';

const BODY_CONTEXT_SIZE_LIMIT = 10_000;

export interface NetworkRequestConcise {
  readonly requestId: number;
  readonly method: string;
  readonly url: string;
  readonly status: string;
}

export interface NetworkRequestDetailed extends NetworkRequestConcise {
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestBody?: string;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly responseBody?: string;
  readonly failure?: string;
  readonly redirectChain?: readonly NetworkRequestConcise[];
}

export class NetworkFormatter {
  readonly #request: HTTPRequest;
  readonly #requestId: number;
  readonly #requestIdResolver?: (request: HTTPRequest) => number;
  #requestBody: string | undefined;
  #responseBody: string | undefined;

  private constructor(
    request: HTTPRequest,
    options: Readonly<{
      requestId: number;
      requestIdResolver?: (request: HTTPRequest) => number;
    }>,
  ) {
    this.#request = request;
    this.#requestId = options.requestId;
    this.#requestIdResolver = options.requestIdResolver;
  }

  static async from(
    request: HTTPRequest,
    options: Readonly<{
      requestId: number;
      requestIdResolver?: (request: HTTPRequest) => number;
      fetchData?: boolean;
    }>,
  ): Promise<NetworkFormatter> {
    const formatter = new NetworkFormatter(request, options);
    if (options.fetchData) await formatter.#loadDetailedData();
    return formatter;
  }

  async #loadDetailedData(): Promise<void> {
    if (this.#request.hasPostData()) {
      let data: string | undefined;
      try {
        data = this.#request.postData() ?? await this.#request.fetchPostData();
      } catch {
        // The browser may already have discarded request data.
      }
      this.#requestBody = data
        ? sizeLimitedString(data, BODY_CONTEXT_SIZE_LIMIT)
        : '<Request body not available anymore>';
    }

    const response = this.#request.response();
    if (response) {
      this.#responseBody = await formattedResponseBody(response, BODY_CONTEXT_SIZE_LIMIT);
    }
  }

  toString(): string {
    return conciseToString(this.toJSON());
  }

  toStringDetailed(): string {
    return detailedToString(this.toJSONDetailed());
  }

  toJSON(): NetworkRequestConcise {
    return {
      requestId: this.#requestId,
      method: this.#request.method(),
      url: this.#request.url(),
      status: requestStatus(this.#request),
    };
  }

  toJSONDetailed(): NetworkRequestDetailed {
    const redirectChain = [...this.#request.redirectChain()].reverse().map((request) => ({
      requestId: this.#requestIdResolver?.(request) ?? -1,
      method: request.method(),
      url: request.url(),
      status: requestStatus(request),
    }));
    return {
      ...this.toJSON(),
      requestHeaders: this.#request.headers(),
      requestBody: this.#requestBody,
      responseHeaders: this.#request.response()?.headers(),
      responseBody: this.#responseBody,
      failure: this.#request.failure()?.errorText,
      redirectChain: redirectChain.length > 0 ? redirectChain : undefined,
    };
  }
}

function requestStatus(request: HTTPRequest): string {
  const response = request.response();
  if (response) return response.status().toString();
  return request.failure()?.errorText ?? 'pending';
}

async function formattedResponseBody(
  response: HTTPResponse,
  sizeLimit: number,
): Promise<string> {
  try {
    const buffer = await response.buffer();
    if (!isUtf8(buffer)) return '<binary data>';
    const text = buffer.toString('utf8');
    return text.length === 0 ? '<empty response>' : sizeLimitedString(text, sizeLimit);
  } catch {
    return '<not available anymore>';
  }
}

function sizeLimitedString(text: string, sizeLimit: number): string {
  return text.length > sizeLimit ? `${text.substring(0, sizeLimit)}... <truncated>` : text;
}

function conciseToString(request: NetworkRequestConcise): string {
  return `reqid=${request.requestId} ${request.method} ${request.url} [${request.status}]`;
}

function detailedToString(request: NetworkRequestDetailed): string {
  const lines = [
    `## Request ${request.url}`,
    `Status: ${request.status}`,
    '### Request Headers',
    ...formatHeaders(request.requestHeaders),
  ];
  if (request.requestBody) lines.push('### Request Body', request.requestBody);
  if (request.responseHeaders) {
    lines.push('### Response Headers', ...formatHeaders(request.responseHeaders));
  }
  if (request.responseBody) lines.push('### Response Body', request.responseBody);
  if (request.failure) lines.push('### Request failed with', request.failure);
  if (request.redirectChain?.length) {
    lines.push('### Redirect chain');
    request.redirectChain.forEach((redirect, index) => {
      lines.push(`${'  '.repeat(index)}${conciseToString(redirect)}`);
    });
  }
  return lines.join('\n');
}

function formatHeaders(headers: Readonly<Record<string, string>>): string[] {
  return Object.entries(headers).map(([name, value]) => `- ${name}:${value}`);
}
