/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Piskie Team, 2026.
 * Adapted from chrome-devtools-mcp@1.7.0
 * src/formatters/ConsoleFormatter.ts. DevTools source-map and issue formatting
 * were removed; console arguments retain the previous Piskie behavior.
 */

import type { ConsoleMessage } from 'puppeteer-core';
import type { ConsoleObservation } from './page-collector.js';

export interface ConsoleMessageConcise {
  readonly type: string;
  readonly text: string;
  readonly argsCount: number;
  readonly id: number;
  readonly count?: number;
}

export interface ConsoleMessageDetailed extends ConsoleMessageConcise {
  readonly args: readonly string[];
}

export class ConsoleFormatter {
  readonly #id: number;
  readonly #type: string;
  readonly #text: string;
  readonly #argsCount: number;
  readonly #resolvedArgs: readonly unknown[];

  protected constructor(params: {
    id: number;
    type: string;
    text: string;
    argsCount?: number;
    resolvedArgs?: readonly unknown[];
  }) {
    this.#id = params.id;
    this.#type = params.type;
    this.#text = params.text;
    this.#argsCount = params.argsCount ?? 0;
    this.#resolvedArgs = params.resolvedArgs ?? [];
  }

  static async from(
    message: ConsoleObservation,
    options: Readonly<{ id: number; fetchDetailedData?: boolean }>,
  ): Promise<ConsoleFormatter> {
    if (message instanceof Error) {
      return new ConsoleFormatter({
        id: options.id,
        type: 'error',
        text: message.message,
      });
    }

    let resolvedArgs: unknown[] = [];
    if (options.fetchDetailedData) {
      resolvedArgs = await resolveConsoleArguments(message);
    }
    return new ConsoleFormatter({
      id: options.id,
      type: message.type(),
      text: message.text(),
      argsCount: resolvedArgs.length || message.args().length,
      resolvedArgs,
    });
  }

  static groupConsecutive(messages: readonly ConsoleFormatter[]): readonly ConsoleFormatter[] {
    const grouped: Array<{ message: ConsoleFormatter; count: number }> = [];
    for (const message of messages) {
      const previous = grouped.at(-1);
      if (
        previous
        && previous.message.#type === message.#type
        && previous.message.#text === message.#text
        && previous.message.#argsCount === message.#argsCount
      ) {
        previous.count += 1;
      } else {
        grouped.push({ message, count: 1 });
      }
    }
    return grouped.map(({ message, count }) => (
      count > 1
        ? new GroupedConsoleFormatter({
            id: message.#id,
            type: message.#type,
            text: message.#text,
            argsCount: message.#argsCount,
          }, count)
        : message
    ));
  }

  toString(): string {
    return conciseToString(this.toJSON());
  }

  toStringDetailed(): string {
    const message = this.toJSONDetailed();
    const lines = [
      `ID: ${message.id}`,
      `Message: ${message.type}> ${message.text}`,
      formatArguments(message.args),
    ].filter(Boolean);
    return lines.join('\n');
  }

  toJSON(): ConsoleMessageConcise {
    return {
      type: this.#type,
      text: this.#text,
      argsCount: this.#argsCount,
      id: this.#id,
    };
  }

  toJSONDetailed(): ConsoleMessageDetailed {
    const args = [...this.#resolvedArgs];
    if (!this.#text) args.shift();
    return {
      ...this.toJSON(),
      args: args.map(formatArgument),
    };
  }
}

class GroupedConsoleFormatter extends ConsoleFormatter {
  readonly #count: number;

  constructor(
    params: { id: number; type: string; text: string; argsCount: number },
    count: number,
  ) {
    super(params);
    this.#count = count;
  }

  override toJSON(): ConsoleMessageConcise {
    return { ...super.toJSON(), count: this.#count };
  }
}

async function resolveConsoleArguments(message: ConsoleMessage): Promise<unknown[]> {
  return Promise.all(message.args().map(async (argument, index) => {
    try {
      return await argument.jsonValue();
    } catch {
      return `<error: Argument ${index} is no longer available>`;
    }
  }));
}

function conciseToString(message: ConsoleMessageConcise): string {
  const countSuffix = message.count && message.count > 1
    ? ` [${message.count} times]`
    : '';
  return `msgid=${message.id} [${message.type}] ${message.text} `
    + `(${message.argsCount} args)${countSuffix}`;
}

function formatArguments(args: readonly string[]): string {
  if (args.length === 0) return '';
  return ['### Arguments', ...args.map((arg, index) => `Arg #${index}: ${arg}`)].join('\n');
}

function formatArgument(argument: unknown): string {
  if (typeof argument !== 'object') return String(argument);
  try {
    return JSON.stringify(argument);
  } catch {
    return String(argument);
  }
}
