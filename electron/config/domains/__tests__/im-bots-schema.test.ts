import { describe, expect, it } from 'vitest';

import { imBotsStoredSchema, imBotsWriteSchema } from '../im-bots.adapter.js';

function bot(replyForward: Record<string, unknown>) {
  return {
    bots: {
      'bot-1': {
        channelType: 'openclaw-weixin',
        name: 'Bot',
        definitionId: 'td-AAAAAA',
        replyForward,
      },
    },
  };
}

describe('im-bots assistant text hard cut', () => {
  it('accepts only forwardAssistantText and rejects the removed forwardThinking key', () => {
    expect(imBotsWriteSchema.safeParse(bot({
      forwardAssistantText: true,
      forwardToolCalls: false,
      forwardToolResults: false,
    })).success).toBe(true);

    expect(imBotsWriteSchema.safeParse(bot({
      forwardThinking: true,
      forwardToolCalls: false,
      forwardToolResults: false,
    })).success).toBe(false);
  });

  it('accepts definitionId and rejects retired binding fields on write', () => {
    const current = bot({
      forwardAssistantText: true,
      forwardToolCalls: false,
      forwardToolResults: false,
    });
    expect(imBotsWriteSchema.safeParse(current).success).toBe(true);

    const withRetiredBinding = structuredClone(current);
    Object.assign(withRetiredBinding.bots['bot-1']!, { bindFlowId: 'flow-1' });
    expect(imBotsWriteSchema.safeParse(withRetiredBinding).success).toBe(false);

    const withRenamedBinding = structuredClone(current);
    Object.assign(withRenamedBinding.bots['bot-1']!, { taskDefinitionId: 'td-old' });
    expect(imBotsWriteSchema.safeParse(withRenamedBinding).success).toBe(false);
  });

  it('ignores retired fields on read and defaults missing agentBindings', () => {
    const parsed = imBotsStoredSchema.parse({
      revision: 3,
      bots: {
        legacy: {
          channelType: 'openclaw-weixin',
          name: 'Legacy Bot',
          bindFlowId: 'flow-old',
        },
        current: {
          channelType: 'openclaw-weixin',
          name: 'Current Bot',
          bindFlowId: 'flow-old',
          taskDefinitionId: 'td-renamed',
          definitionId: 'td-current',
        },
      },
    });

    expect(parsed.bots.legacy).toEqual({
      channelType: 'openclaw-weixin',
      name: 'Legacy Bot',
    });
    expect(parsed.bots.current).toEqual({
      channelType: 'openclaw-weixin',
      name: 'Current Bot',
      definitionId: 'td-current',
    });
    expect(parsed.agentBindings).toEqual({});
  });

  it('accepts natural conversation bindings without another identifier', () => {
    const current = bot({
      forwardAssistantText: true,
      forwardToolCalls: false,
      forwardToolResults: false,
    });
    expect(imBotsWriteSchema.parse({
      ...current,
      agentBindings: {
        'bot-1': [{ peerKind: 'direct', peerId: 'user-1', agentId: 'agent-1' }],
      },
    }).agentBindings).toEqual({
      'bot-1': [{ peerKind: 'direct', peerId: 'user-1', agentId: 'agent-1' }],
    });
  });
});
