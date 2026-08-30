import type Anthropic from '@anthropic-ai/sdk';

// Anthropic checks at most 20 blocks behind each breakpoint for a prior cache entry.
const CACHE_LOOKBACK_BLOCKS = 20;
const MAX_CACHE_BREAKPOINTS = 4;

export interface AnthropicPromptCacheInput {
  system: readonly Anthropic.TextBlockParam[];
  messages: readonly Anthropic.MessageParam[];
  tools?: readonly Anthropic.Tool[];
}

export interface AnthropicPromptCacheResult {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  automatic?: Anthropic.CacheControlEphemeral;
}

/** Applies Anthropic cache breakpoints without leaking the wire policy into the AI domain. */
export function applyAnthropicPromptCache(
  input: AnthropicPromptCacheInput,
  enabled: boolean,
): AnthropicPromptCacheResult {
  if (!enabled) {
    return {
      system: [...input.system],
      messages: [...input.messages],
      ...(input.tools && { tools: [...input.tools] }),
    };
  }

  const system = markLast(input.system);
  const tools = input.tools ? markLast(input.tools) : undefined;
  const stablePrefixBreakpoints = Number(system.length > 0) + Number((tools?.length ?? 0) > 0);
  const historyBreakpoints = MAX_CACHE_BREAKPOINTS - 1 - stablePrefixBreakpoints;

  return {
    system,
    messages: markRollingHistoryCheckpoints(input.messages, historyBreakpoints),
    ...(tools && { tools }),
    automatic: ephemeral(),
  };
}

function markLast<T extends { cache_control?: Anthropic.CacheControlEphemeral | null }>(
  values: readonly T[],
): T[] {
  const result = [...values];
  const index = result.length - 1;
  const value = result[index];
  if (value) result[index] = { ...value, cache_control: ephemeral() };
  return result;
}

function markRollingHistoryCheckpoints(
  messages: readonly Anthropic.MessageParam[],
  maxBreakpoints: number,
): Anthropic.MessageParam[] {
  const result = [...messages];
  let distanceFromTail = 0;
  let nextCheckpoint = CACHE_LOOKBACK_BLOCKS;
  let remaining = maxBreakpoints;

  for (let messageIndex = result.length - 1; messageIndex >= 0; messageIndex--) {
    if (remaining === 0) break;
    const message = result[messageIndex]!;
    if (typeof message.content === 'string') {
      distanceFromTail++;
      if (distanceFromTail < nextCheckpoint) continue;
      result[messageIndex] = markStringMessage(message);
      remaining--;
      nextCheckpoint = distanceFromTail + CACHE_LOOKBACK_BLOCKS;
      continue;
    }

    const content = [...message.content];
    let changed = false;
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
      if (remaining === 0) break;
      distanceFromTail++;
      if (distanceFromTail < nextCheckpoint) continue;
      const block = content[blockIndex];
      if (!block || !isCacheable(block)) continue;
      content[blockIndex] = { ...block, cache_control: ephemeral() } as Anthropic.ContentBlockParam;
      changed = true;
      remaining--;
      nextCheckpoint = distanceFromTail + CACHE_LOOKBACK_BLOCKS;
    }
    if (changed) result[messageIndex] = { ...message, content };
  }

  return result;
}

function markStringMessage(message: Anthropic.MessageParam): Anthropic.MessageParam {
  return {
    ...message,
    content: [{ type: 'text', text: message.content as string, cache_control: ephemeral() }],
  };
}

function isCacheable(block: Anthropic.ContentBlockParam): boolean {
  return block.type !== 'thinking' && block.type !== 'redacted_thinking';
}

function ephemeral(): Anthropic.CacheControlEphemeral {
  return { type: 'ephemeral' };
}
