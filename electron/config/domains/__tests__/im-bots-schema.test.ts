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

describe('im-bots auto-start', () => {
  const config = { channelType: 'openclaw-weixin', name: 'Example Bot' };

  it('defaults missing values off for both new writes and existing stored Bots', () => {
    const document = { bots: { example: config } };
    expect(imBotsWriteSchema.parse(document).bots.example?.autoStart).toBe(false);
    expect(imBotsStoredSchema.parse({ ...document, revision: 1 }).bots.example?.autoStart).toBe(false);
  });

  it.each([false, true])('preserves explicit autoStart=%s through write and read schemas', (autoStart) => {
    const written = imBotsWriteSchema.parse({ bots: { example: { ...config, autoStart } } });
    expect(written.bots.example?.autoStart).toBe(autoStart);
    expect(imBotsStoredSchema.parse({ ...written, revision: 1 }).bots.example?.autoStart).toBe(autoStart);
  });

  it('rejects non-boolean writes while retaining tolerant reads and strict writes for unknown keys', () => {
    const document = { bots: { example: { ...config, autoStart: true, unknownOption: true } } };
    expect(imBotsStoredSchema.parse({ ...document, revision: 1 }).bots.example).toEqual({ ...config, autoStart: true });
    expect(imBotsWriteSchema.safeParse(document).success).toBe(false);
    expect(imBotsWriteSchema.safeParse({ bots: { example: { ...config, autoStart: 'true' } } }).success).toBe(false);
  });
});

describe('im-bots assistant text hard cut', () => {
  it('defaults tool images on, preserves explicit off, and keeps reads tolerant and writes strict', () => {
    const reply = { forwardAssistantText: true, forwardToolCalls: false, forwardToolResults: false };
    expect(imBotsStoredSchema.parse({ ...bot(reply), revision: 1 }).bots['bot-1']?.replyForward?.forwardToolImages).toBe(true);
    expect(imBotsWriteSchema.parse(bot({ ...reply, forwardToolImages: false })).bots['bot-1']?.replyForward?.forwardToolImages).toBe(false);
    expect(imBotsStoredSchema.parse({ ...bot({ ...reply, unknownOption: true }), revision: 1 }).bots['bot-1']?.replyForward).toEqual({ ...reply, forwardToolImages: true });
    expect(imBotsWriteSchema.safeParse(bot({ ...reply, unknownOption: true })).success).toBe(false);
  });
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
      autoStart: false,
    });
    expect(parsed.bots.current).toEqual({
      channelType: 'openclaw-weixin',
      name: 'Current Bot',
      definitionId: 'td-current',
      autoStart: false,
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
