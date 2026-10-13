/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/devtools/DevtoolsUtils.ts
 * (SymbolizedError). The fixed frontend observation model supplies lookups.
 */

import type { Protocol } from 'puppeteer-core';

export interface ConsoleStackFrame {
  readonly name?: string;
  readonly url?: string;
  readonly line: number;
  readonly column: number;
  readonly uiSourceCode?: {
    uiLocation(line: number, column: number): {
      linkText(skipTrim: boolean, showColumnNumber: boolean): string;
    };
  };
}

export interface ConsoleStackTrace {
  readonly syncFragment: { readonly frames: readonly ConsoleStackFrame[] };
  readonly asyncFragments: readonly {
    readonly description?: string;
    readonly frames: readonly ConsoleStackFrame[];
  }[];
}

export interface ConsoleDevToolsModel {
  stackTrace(raw: Protocol.Runtime.StackTrace, targetId?: string): Promise<ConsoleStackTrace>;
  exceptionDetails(error: Protocol.Runtime.RemoteObject, targetId?: string): Promise<Protocol.Runtime.ExceptionDetails | undefined>;
  cause(error: Protocol.Runtime.RemoteObject, targetId?: string): Promise<Protocol.Runtime.RemoteObject | undefined>;
  isIgnored(frame: ConsoleStackFrame): boolean;
  dispose(): void;
}

export class SymbolizedError {
  constructor(
    readonly message: string,
    readonly stackTrace?: ConsoleStackTrace,
    readonly cause?: SymbolizedError,
  ) {}

  static async fromDetails(options: {
    details: Protocol.Runtime.ExceptionDetails;
    targetId?: string;
    devTools?: ConsoleDevToolsModel;
    includeStackAndCause?: boolean;
  }): Promise<SymbolizedError> {
    const { details, targetId, devTools } = options;
    const message = details.text === 'Uncaught' && details.exception
      ? `Uncaught ${messageFromException(details.exception)}` : details.text;
    if (!options.includeStackAndCause || !devTools) return new SymbolizedError(message);
    let stackTrace: ConsoleStackTrace | undefined;
    if (details.stackTrace) {
      try { stackTrace = await devTools.stackTrace(details.stackTrace, targetId); } catch { /* upstream ignores */ }
    }
    let cause: SymbolizedError | undefined;
    if (details.exception) {
      try {
        const remoteCause = await devTools.cause(details.exception, targetId);
        if (remoteCause) cause = await SymbolizedError.fromError({ error: remoteCause, targetId, devTools });
      } catch { /* upstream ignores */ }
    }
    return new SymbolizedError(message, stackTrace, cause);
  }

  static async fromError(options: {
    error: Protocol.Runtime.RemoteObject;
    targetId?: string;
    devTools?: ConsoleDevToolsModel;
  }): Promise<SymbolizedError> {
    const details = options.devTools
      ? await options.devTools.exceptionDetails(options.error, options.targetId) : undefined;
    return details
      ? SymbolizedError.fromDetails({ ...options, details, includeStackAndCause: true })
      : new SymbolizedError(messageFromException(options.error));
  }
}

function messageFromException(error: Protocol.Runtime.RemoteObject): string {
  return error.description?.split('\n    at ', 2)[0] ?? '';
}
