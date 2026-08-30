/** Locale-neutral summaries for canonical tool inputs and results. */

import {
  messageText,
  rawText,
  type PresentationText,
} from '../presentationText';

export interface ToolResultView {
  readonly tool: string;
  readonly params?: unknown;
  /** Canonical result: raw text or one parsed JSON object/array. */
  readonly result?: unknown;
}

interface TextBlock {
  readonly type?: unknown;
  readonly text?: unknown;
}

function extractTextBlocks(result: unknown): string | undefined {
  if (!Array.isArray(result)) return undefined;
  const text = (result as readonly TextBlock[])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim();
  return text || undefined;
}

function parseJsonContainer(value: unknown): object | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const hasObjectDelimiters = text.startsWith('{') && text.endsWith('}');
  const hasArrayDelimiters = text.startsWith('[') && text.endsWith(']');
  if (!hasObjectDelimiters && !hasArrayDelimiters) return undefined;

  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Only complete JSON object/array containers are treated as structured results. */
export function isJsonLikeString(value: unknown): boolean {
  return parseJsonContainer(value) !== undefined;
}

export function parseMaybeJson(value: unknown): unknown {
  return parseJsonContainer(value) ?? value;
}

export function summarizeText(value: string | undefined, maxLength = 120): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function readableRawText(value: unknown): string | undefined {
  if (typeof value !== 'string' || isJsonLikeString(value)) return undefined;
  return value.trim() || undefined;
}

/** Explicit text blocks and non-JSON strings are the only generic readable result sources. */
export function readableToolResultText(result: unknown): string | undefined {
  return extractTextBlocks(result) ?? readableRawText(result);
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function stringField(
  params: Readonly<Record<string, unknown>>,
  key: string,
  maxLength = 140,
): PresentationText | undefined {
  const value = params[key];
  const summary = typeof value === 'string' ? summarizeText(value, maxLength) : undefined;
  return summary ? rawText(summary) : undefined;
}

function firstQuestion(params: Readonly<Record<string, unknown>>): PresentationText | undefined {
  const questions = params.questions;
  if (!Array.isArray(questions)) return undefined;
  const question = recordOf(questions[0]);
  return question ? stringField(question, 'question', 140) : undefined;
}

/**
 * Each branch owns one known tool contract. Unknown tools and unknown object fields deliberately
 * produce no summary; their localized/catalog title and opt-in details remain available.
 */
export function toolParamsSummary(view: ToolResultView): PresentationText | undefined {
  const params = recordOf(view.params);
  if (!params) return undefined;

  switch (view.tool) {
    case 'ask_user':
      return firstQuestion(params);
    case 'subagent':
      return stringField(params, 'subject') ?? stringField(params, 'subagentId');
    case 'plan':
    case 'task':
      return stringField(params, 'taskSummary');
    case 'send_event':
      return stringField(params, 'summary') ?? stringField(params, 'message');
    case 'load_skill':
      return stringField(params, 'skill');
    case 'tool_search': {
      const query = stringField(params, 'query', 100);
      return query ? messageText('transcript.summary.query', { query }) : undefined;
    }
    case 'read':
    case 'write':
    case 'edit':
      return stringField(params, 'file_path');
    case 'ls':
      return stringField(params, 'path');
    case 'glob':
      return stringField(params, 'pattern');
    case 'grep': {
      const pattern = stringField(params, 'pattern', 100);
      return pattern ? messageText('transcript.summary.query', { query: pattern }) : undefined;
    }
    case 'shell':
      return stringField(params, 'description') ?? stringField(params, 'command');
    case 'generate_image':
      return stringField(params, 'prompt');
    case 'browser_navigate':
      return stringField(params, 'url');
    default:
      return undefined;
  }
}

export function toolResultSummary(view: ToolResultView): PresentationText | undefined {
  const summary = summarizeText(readableToolResultText(view.result), 120);
  return summary ? rawText(summary) : undefined;
}

export function serializableLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + serializableLength(item), 0);
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

export function hasSerializableContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  return serializableLength(value) > 0;
}
