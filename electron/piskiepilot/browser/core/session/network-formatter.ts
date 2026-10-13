/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/formatters/NetworkFormatter.ts.
 * File saving is supplied by the host. The adopted default exposes headers.
 */

import { isUtf8 } from 'node:buffer';
import type { HTTPRequest, HTTPResponse } from 'puppeteer-core';

const BODY_CONTEXT_SIZE_LIMIT = 10_000;
const URL_CONTEXT_SIZE_LIMIT = 255;

export interface NetworkFormatterOptions {
  readonly requestId?: number | string;
  readonly selectedInDevToolsUI?: boolean;
  readonly requestIdResolver?: (request: HTTPRequest) => number | string;
  readonly fetchData?: boolean;
  readonly requestFilePath?: string;
  readonly responseFilePath?: string;
  readonly saveFile?: (
    data: Uint8Array,
    filename: string,
    extension: '.network-request' | '.network-response',
  ) => Promise<{ filename: string }>;
}

export interface NetworkRequestConcise {
  readonly requestId?: number | string;
  readonly method: string;
  readonly url: string;
  readonly status: string;
  readonly selectedInDevToolsUI?: boolean;
}

export interface NetworkRequestDetailed extends NetworkRequestConcise {
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestBody?: string;
  readonly requestBodyFilePath?: string;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly responseBody?: string;
  readonly responseBodyFilePath?: string;
  readonly failure?: string;
  readonly redirectChain?: readonly NetworkRequestConcise[];
}

export class NetworkFormatter {
  readonly #request: HTTPRequest;
  readonly #options: NetworkFormatterOptions;
  #requestBody?: string;
  #responseBody?: string;
  #requestBodyFilePath?: string;
  #responseBodyFilePath?: string;

  private constructor(request: HTTPRequest, options: NetworkFormatterOptions) {
    this.#request = request;
    this.#options = options;
  }

  static async from(
    request: HTTPRequest,
    options: NetworkFormatterOptions,
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
        // Upstream ignores request-body parsing errors.
      }
      if (this.#options.requestFilePath) {
        if (!this.#options.saveFile) {
          throw new Error('Unable to save the request body to a file: no saveFile callback was configured.');
        }
        if (data) {
          const { filename } = await this.#options.saveFile(
            Buffer.from(data), this.#options.requestFilePath, '.network-request',
          );
          this.#requestBodyFilePath = filename;
        } else {
          this.#requestBody = '<Request body not available anymore>';
        }
      } else {
        this.#requestBody = data
          ? sizeLimitedString(data, BODY_CONTEXT_SIZE_LIMIT)
          : '<Request body not available anymore>';
      }
    }
    const response = this.#request.response();
    if (response) {
      if (this.#options.responseFilePath) {
        try {
          const buffer = await response.buffer();
          if (!this.#options.saveFile) {
            throw new Error('Unable to save the response body to a file: no saveFile callback was configured.');
          }
          const { filename } = await this.#options.saveFile(
            buffer, this.#options.responseFilePath, '.network-response',
          );
          this.#responseBodyFilePath = filename;
        } catch {
          // Upstream flattens both response-body reads and writes into this marker.
        }
        if (!this.#responseBodyFilePath) this.#responseBody = '<Response body not available anymore>';
      } else {
        this.#responseBody = await formattedResponseBody(response, BODY_CONTEXT_SIZE_LIMIT);
      }
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
      requestId: this.#options.requestId,
      method: this.#request.method(),
      url: this.#request.url(),
      status: requestStatus(this.#request),
      selectedInDevToolsUI: this.#options.selectedInDevToolsUI,
    };
  }

  toJSONDetailed(): NetworkRequestDetailed {
    const redirectChain = this.#request.redirectChain().reverse().map(request => (
      new NetworkFormatter(request, { requestId: this.#options.requestIdResolver?.(request) }).toJSON()
    ));
    return {
      ...this.toJSON(),
      requestHeaders: this.#request.headers(),
      requestBody: this.#requestBody,
      requestBodyFilePath: this.#requestBodyFilePath,
      responseHeaders: this.#request.response()?.headers(),
      responseBody: this.#responseBody,
      responseBodyFilePath: this.#responseBodyFilePath,
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

async function formattedResponseBody(response: HTTPResponse, sizeLimit: number): Promise<string> {
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
  return `reqid=${request.requestId} ${request.method} ${sizeLimitedString(request.url, URL_CONTEXT_SIZE_LIMIT)} [${request.status}]`
    + (request.selectedInDevToolsUI ? ' [selected in the DevTools Network panel]' : '');
}

function detailedToString(request: NetworkRequestDetailed): string {
  const lines = [
    `## Request ${request.url}`,
    `Status: ${request.status}`,
    '### Request Headers',
    ...formatHeaders(request.requestHeaders),
  ];
  if (request.requestBody) lines.push('### Request Body', request.requestBody);
  else if (request.requestBodyFilePath) lines.push('### Request Body', `Saved to ${request.requestBodyFilePath}.`);
  if (request.responseHeaders) lines.push('### Response Headers', ...formatHeaders(request.responseHeaders));
  if (request.responseBody) lines.push('### Response Body', request.responseBody);
  else if (request.responseBodyFilePath) lines.push('### Response Body', `Saved to ${request.responseBodyFilePath}.`);
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
