/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.10.1 src/formatters/ConsoleFormatter.ts.
 * Uses the local observation-only DevTools model for source maps and causes.
 */

import type { ConsoleMessage, Protocol } from 'puppeteer-core';
import { UncaughtError, type ConsoleObservation } from './page-collector.js';
import type { IssueFormatter } from './issue-formatter.js';
import { SymbolizedError, type ConsoleDevToolsModel, type ConsoleStackFrame, type ConsoleStackTrace } from './console-stack.js';

export interface ConsoleFormatterOptions {
  readonly id: number;
  readonly fetchDetailedData?: boolean;
  readonly fetchStackTrace?: boolean;
  readonly devTools?: ConsoleDevToolsModel;
}
export interface ConsoleMessageConcise {
  readonly type: string;
  readonly text: string;
  readonly argsCount: number;
  readonly id: number;
  readonly count?: number;
  readonly stackTrace?: string;
}
export interface ConsoleMessageDetailed extends ConsoleMessageConcise {
  readonly args: readonly string[];
}
export type IgnoreCheck = (frame: ConsoleStackFrame) => boolean;

interface ConsoleFormatterParameters {
  id: number; type: string; text: string; argsCount?: number;
  resolvedArgs?: readonly unknown[]; stack?: ConsoleStackTrace;
  cause?: SymbolizedError; includeStackInConcise?: boolean; isIgnored: IgnoreCheck;
}

export class ConsoleFormatter {
  readonly #id: number;
  readonly #type: string;
  readonly #text: string;
  readonly #argsCount: number;
  readonly #resolvedArgs: readonly unknown[];
  readonly #stack?: ConsoleStackTrace;
  readonly #cause?: SymbolizedError;
  readonly #includeStackInConcise: boolean;
  readonly isIgnored: IgnoreCheck;

  protected constructor(params: ConsoleFormatterParameters) {
    this.#id = params.id;
    this.#type = params.type;
    this.#text = params.text;
    this.#argsCount = params.argsCount ?? 0;
    this.#resolvedArgs = params.resolvedArgs ?? [];
    this.#stack = params.stack;
    this.#cause = params.cause;
    this.#includeStackInConcise = params.includeStackInConcise ?? false;
    this.isIgnored = params.isIgnored;
  }

  static async from(message: Exclude<ConsoleObservation, import('./page-collector.js').ConsoleIssue>, options: ConsoleFormatterOptions): Promise<ConsoleFormatter> {
    const isIgnored: IgnoreCheck = frame => options.devTools?.isIgnored(frame) ?? false;
    if (message instanceof UncaughtError) {
      const error = await SymbolizedError.fromDetails({
        details: message.details, targetId: message.targetId, devTools: options.devTools,
        includeStackAndCause: options.fetchDetailedData || options.fetchStackTrace,
      });
      return new ConsoleFormatter({ id: options.id, type: 'error', text: error.message,
        stack: error.stackTrace, cause: error.cause, includeStackInConcise: options.fetchStackTrace, isIgnored });
    }
    if (message instanceof Error) {
      return new ConsoleFormatter({ id: options.id, type: 'error', text: message.message, isIgnored });
    }
    const resolvedArgs = options.fetchDetailedData
      ? await resolveConsoleArguments(message, options.devTools) : [];
    let stack: ConsoleStackTrace | undefined;
    if ((options.fetchDetailedData || options.fetchStackTrace) && options.devTools) {
      try {
        const msg = message as ConsoleMessage & {
          _rawStackTrace(): Protocol.Runtime.StackTrace | undefined;
          _targetId(): string | undefined;
        };
        const raw = msg._rawStackTrace();
        if (raw) stack = await options.devTools.stackTrace(raw, msg._targetId());
      } catch { /* upstream ignores unavailable stack traces */ }
    }
    return new ConsoleFormatter({
      id: options.id, type: message.type(), text: message.text(),
      argsCount: resolvedArgs.length || message.args().length, resolvedArgs, stack,
      includeStackInConcise: options.fetchStackTrace, isIgnored,
    });
  }

  static groupConsecutive<T extends ConsoleFormatter | IssueFormatter>(messages: readonly T[]): Array<T | ConsoleFormatter> {
    const grouped: Array<{ message: T; count: number }> = [];
    for (const message of messages) {
      const previous = grouped.at(-1);
      if (previous && previous.message instanceof ConsoleFormatter && message instanceof ConsoleFormatter
        && previous.message.#type === message.#type && previous.message.#getText() === message.#getText()
        && previous.message.#argsCount === message.#argsCount) previous.count += 1;
      else grouped.push({ message, count: 1 });
    }
    return grouped.map(({ message, count }) => count > 1 && message instanceof ConsoleFormatter
      ? new GroupedConsoleFormatter({
          id: message.#id, type: message.#type, text: message.#text, argsCount: message.#argsCount,
          stack: message.#stack, cause: message.#cause, includeStackInConcise: message.#includeStackInConcise,
          isIgnored: message.isIgnored,
        }, count) : message);
  }

  #getText(): string {
    if (this.#text) return this.#text;
    return this.#resolvedArgs.length > 0 ? formatArgument(this.#resolvedArgs[0], this) : '';
  }

  toString(): string {
    const message = this.toJSON();
    const countSuffix = message.count && message.count > 1 ? ` [${message.count} times]` : '';
    const line = `msgid=${message.id} [${message.type}] ${message.text} (${message.argsCount} args)${countSuffix}`;
    return message.stackTrace ? `${line}\n${message.stackTrace.split('\n').map(line => `  ${line}`).join('\n')}` : line;
  }

  toStringDetailed(): string {
    const message = this.toJSONDetailed();
    return [`ID: ${message.id}`, `Message: ${message.type}> ${message.text}`,
      message.args.length ? ['### Arguments', ...message.args.map((arg, index) => `Arg #${index}: ${arg}`)].join('\n') : '',
      ...(message.stackTrace ? ['### Stack trace', message.stackTrace] : []),
    ].filter(Boolean).join('\n');
  }

  toJSON(): ConsoleMessageConcise {
    return { type: this.#type, text: this.#getText(), argsCount: this.#argsCount, id: this.#id,
      ...(this.#includeStackInConcise && this.#stack
        ? { stackTrace: formatStackTrace(this.#stack, this.#cause, this, false) } : {}),
    };
  }

  toJSONDetailed(): ConsoleMessageDetailed {
    const args = [...this.#resolvedArgs];
    if (!this.#text) args.shift();
    return { id: this.#id, type: this.#type, text: this.#getText(), argsCount: this.#argsCount,
      args: args.map(arg => formatArgument(arg, this)),
      stackTrace: this.#stack ? formatStackTrace(this.#stack, this.#cause, this) : undefined,
    };
  }
}

export class GroupedConsoleFormatter extends ConsoleFormatter {
  constructor(params: ConsoleFormatterParameters, readonly count: number) { super(params); }
  override toJSON(): ConsoleMessageConcise { return { ...super.toJSON(), count: this.count }; }
}

async function resolveConsoleArguments(message: ConsoleMessage, devTools?: ConsoleDevToolsModel): Promise<unknown[]> {
  return Promise.all(message.args().map(async (argument, index) => {
    try {
      const remote = argument.remoteObject();
      if (remote.type === 'object' && remote.subtype === 'error') {
        return await SymbolizedError.fromError({ error: remote, devTools,
          targetId: (message as ConsoleMessage & { _targetId(): string | undefined })._targetId() });
      }
      return await argument.jsonValue();
    } catch { return `<error: Argument ${index} is no longer available>`; }
  }));
}

function formatArgument(argument: unknown, formatter: { isIgnored: IgnoreCheck }): string {
  if (argument instanceof SymbolizedError) {
    return [argument.message, argument.stackTrace ? formatStackTrace(argument.stackTrace, argument.cause, formatter) : '']
      .filter(Boolean).join('\n');
  }
  return typeof argument === 'object' ? JSON.stringify(argument) : String(argument);
}

function formatStackTrace(stack: ConsoleStackTrace, cause: SymbolizedError | undefined, formatter: { isIgnored: IgnoreCheck }, includeNote = true): string {
  const lines = stackLines(stack, cause, formatter);
  const included = lines.slice(0, 50);
  return [...included, lines.length > included.length ? `... and ${lines.length - included.length} more frames` : '',
    includeNote ? 'Note: line and column numbers use 1-based indexing' : '',
  ].filter(Boolean).join('\n');
}

function stackLines(stack: ConsoleStackTrace | undefined, cause: SymbolizedError | undefined, formatter: { isIgnored: IgnoreCheck }): string[] {
  if (!stack) return [];
  return [
    ...fragmentLines(stack.syncFragment, formatter),
    ...stack.asyncFragments.flatMap(fragment => {
      const frames = fragmentLines(fragment, formatter);
      if (!frames.length) return [];
      const prefix = `--- ${fragment.description || 'async'} `;
      return [prefix + '-'.repeat(40 - prefix.length), ...frames];
    }),
    ...(cause ? [`Caused by: ${cause.message}`, ...stackLines(cause.stackTrace, cause.cause, formatter)] : []),
  ];
}

function fragmentLines(fragment: { readonly frames: readonly ConsoleStackFrame[] }, formatter: { isIgnored: IgnoreCheck }): string[] {
  return fragment.frames.filter(frame => !formatter.isIgnored(frame)).map(frame => {
    let line = `at ${frame.name ?? '<anonymous>'}`;
    if (frame.uiSourceCode) line += ` (${frame.uiSourceCode.uiLocation(frame.line, frame.column).linkText(false, true)})`;
    else if (frame.url) line += ` (${frame.url}:${frame.line}:${frame.column})`;
    return line;
  });
}
