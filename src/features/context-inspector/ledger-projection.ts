import type { ContentBlock, Message, Tool, ToolResultContentBlock } from '@shared/types';
import type { ContextSnapshot } from '@shared/types/token';

export type ContextLedgerSection = 'system' | 'tool' | 'message';

export type ContextLedgerRow =
  | {
      readonly kind: 'system';
      readonly key: string;
      readonly title: string;
      readonly subtitle: string;
      readonly searchText: string;
      readonly text: string;
    }
  | {
      readonly kind: 'tool';
      readonly key: string;
      readonly title: string;
      readonly subtitle: string;
      readonly searchText: string;
      readonly toolIndex: number;
      readonly tool: Tool;
    }
  | {
      readonly kind: 'message';
      readonly key: string;
      readonly title: string;
      readonly subtitle: string;
      readonly searchText: string;
      readonly messageIndex: number;
      readonly inputTokens?: number;
      readonly inputTokenDelta?: number;
      readonly message: Message;
    };

export interface ContextLedgerProjection {
  readonly rows: readonly ContextLedgerRow[];
  readonly counts: Readonly<Record<ContextLedgerSection, number>>;
}

export interface ContextLedgerLabels {
  readonly systemPrompt: string;
  readonly assistant: string;
  readonly toolResult: string;
  readonly contextSummary: string;
  readonly user: string;
  readonly emptyContent: string;
}

export function projectContextLedger(
  snapshot: ContextSnapshot,
  generation: number,
  labels: ContextLedgerLabels,
): ContextLedgerProjection {
  const rows: ContextLedgerRow[] = [];
  const checkpointByMessage = new Map<number, {
    readonly inputTokens: number;
    readonly inputTokenDelta?: number;
  }>();
  snapshot.requestTokenCheckpoints.forEach((checkpoint, index, checkpoints) => {
    const previous = checkpoints[index - 1];
    checkpointByMessage.set(checkpoint.messageIndex, {
      inputTokens: checkpoint.inputTokens,
      ...(previous === undefined
        ? {}
        : { inputTokenDelta: checkpoint.inputTokens - previous.inputTokens }),
    });
  });
  rows.push({
    kind: 'system',
    key: `${generation}:system`,
    title: labels.systemPrompt,
    subtitle: compactPreview(snapshot.systemPrompt, labels.emptyContent),
    searchText: snapshot.systemPrompt,
    text: snapshot.systemPrompt,
  });

  snapshot.tools.forEach((tool, toolIndex) => {
    const searchText = `${tool.name}\n${tool.description}\n${safeJson(tool.input_schema)}`;
    rows.push({
      kind: 'tool',
      key: `${generation}:tool:${toolIndex}:${tool.name}`,
      title: tool.name,
      subtitle: compactPreview(safeJson(tool.input_schema), labels.emptyContent),
      searchText,
      toolIndex,
      tool,
    });
  });

  snapshot.messages.forEach((message, messageIndex) => {
    const searchText = readableMessageText(message);
    const checkpoint = checkpointByMessage.get(messageIndex);
    rows.push({
      kind: 'message',
      key: `${generation}:message:${messageIndex}`,
      title: messageTitle(message, labels),
      subtitle: compactPreview(searchText, labels.emptyContent),
      searchText,
      messageIndex,
      ...checkpoint,
      message,
    });
  });

  return {
    rows,
    counts: {
      system: 1,
      tool: snapshot.tools.length,
      message: snapshot.messages.length,
    },
  };
}

export function readableMessageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map(readableBlockText).filter(Boolean).join('\n');
}

export function readableBlockText(block: ContentBlock | ToolResultContentBlock): string {
  const value = block as ContentBlock & Record<string, unknown>;
  switch (value.type) {
    case 'text':
      return value.text ?? '';
    case 'tool_use':
      return [value.name, value.id, safeJson(value.input)].filter(Boolean).join('\n');
    case 'tool_result': {
      const result = value.content;
      const content = typeof result === 'string'
        ? result
        : (result ?? []).map(readableBlockText).filter(Boolean).join('\n');
      return [value.tool_use_id, value.is_error ? 'error' : 'success', content]
        .filter(Boolean)
        .join('\n');
    }
    case 'image':
      return imageMetadata(value.source);
    case 'thinking':
      return value.thinking ?? '';
    case 'redacted_thinking':
      return 'redacted thinking';
    case 'openai_reasoning':
      return [
        ...(value.summary ?? []).map((part) => part.text),
        ...(value.reasoning_content ?? []).map((part) => part.text),
        value.status,
      ].filter(Boolean).join('\n');
    default:
      return safeJson(redactOpaqueFields(value));
  }
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '[unserializable]';
  }
}

function messageTitle(message: Message, labels: ContextLedgerLabels): string {
  if (message.role === 'assistant') return labels.assistant;
  if (
    Array.isArray(message.content)
    && message.content.length > 0
    && message.content.every((block) => block.type === 'tool_result')
  ) {
    return labels.toolResult;
  }
  if (message.subtype === 'context_summary') return labels.contextSummary;
  return labels.user;
}

function compactPreview(value: string, emptyContent: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact || emptyContent;
}

function imageMetadata(source: ContentBlock['source']): string {
  if (!source) return 'image';
  return `image ${source.media_type} ${source.data.length} base64 chars`;
}

function redactOpaqueFields(value: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...value };
  for (const key of ['data', 'signature', 'encrypted_content']) {
    const content = redacted[key];
    if (typeof content === 'string') redacted[key] = `[${content.length} chars]`;
  }
  return redacted;
}
