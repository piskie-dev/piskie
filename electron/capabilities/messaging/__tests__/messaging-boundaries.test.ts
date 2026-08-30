import { describe, expect, it, vi } from 'vitest';

import { MESSAGING_OPERATIONS } from '../../../../shared/electron-contracts/messaging.js';
import { MessagingApplication } from '../messaging-application.js';
import { createMessagingController } from '../messaging-controller.js';

describe('messaging configuration boundaries', () => {
  it('keeps ConfigHost runtime observations outside editor configs', async () => {
    const application = new MessagingApplication({
      config: {
        show: vi.fn(async () => ({
          revision: 1,
          bots: {
            'bot-1': {
              channelType: 'openclaw-weixin',
              name: 'Bot',
              definitionId: 'td-1',
              pluginAccountId: 'account-1',
              status: 'error',
              error: 'projected error',
              startedAt: '2026-08-17T01:00:00.000Z',
            },
          },
        })),
      } as never,
      gateway: {
        getBotStates: () => [],
      } as never,
    });

    const status = await application.status();

    expect(status.configs).toEqual([{
      id: 'bot-1',
      channelType: 'openclaw-weixin',
      name: 'Bot',
      definitionId: 'td-1',
      pluginAccountId: 'account-1',
    }]);
    expect(status.botStates).toEqual([{
      config: status.configs[0],
      status: 'stopped',
    }]);
  });

  it('accepts the known account observation on save but rejects runtime state fields', () => {
    const controller = createMessagingController({} as never);
    const saveBot = controller.operations.find(({ id }) => id === MESSAGING_OPERATIONS.saveBot)!;
    const config = {
      id: 'bot-1',
      channelType: 'openclaw-weixin',
      name: 'Bot',
      definitionId: 'td-1',
      appId: '',
      appSecret: '',
      pluginAccountId: 'account-1',
    };

    expect(saveBot.input.safeParse([config]).success).toBe(true);
    expect(saveBot.input.safeParse([{ ...config, status: 'stopped' }]).success).toBe(false);
  });

  it('clears system-maintained Agent bindings when a Bot changes definition', async () => {
    const config = mutationHost();
    const application = new MessagingApplication({ config: config as never, gateway: {} as never });

    await application.saveBot({
      id: 'bot-1',
      channelType: 'openclaw-weixin',
      name: 'Bot',
      definitionId: 'td-2',
      appId: '',
      appSecret: '',
    });

    expect(config.createPatchPlan).toHaveBeenCalledWith('im-bots', expect.arrayContaining([{
      op: 'remove',
      path: '/agentBindings/bot-1',
    }]));
  });

  it('removes a Bot and its Agent bindings in one Config revision', async () => {
    const config = mutationHost();
    const application = new MessagingApplication({ config: config as never, gateway: {} as never });

    await application.deleteBot('bot-1');

    expect(config.createPatchPlan).toHaveBeenCalledWith('im-bots', expect.arrayContaining([
      { op: 'remove', path: '/bots/bot-1' },
      { op: 'remove', path: '/agentBindings/bot-1' },
    ]));
  });
});

function mutationHost() {
  const current = {
    revision: 3,
    bots: {
      'bot-1': {
        channelType: 'openclaw-weixin',
        name: 'Bot',
        definitionId: 'td-1',
      },
    },
    agentBindings: {
      'bot-1': [{ peerKind: 'direct', peerId: 'user-1', agentId: 'agent-1' }],
    },
  };
  return {
    show: vi.fn(async () => structuredClone(current)),
    createPatchPlan: vi.fn(async () => ({ id: 'plan-1' })),
    validate: vi.fn(async () => ({ id: 'plan-1' })),
    apply: vi.fn(async () => ({ domain: 'im-bots', previousRevision: 3, revision: 4 })),
  };
}
