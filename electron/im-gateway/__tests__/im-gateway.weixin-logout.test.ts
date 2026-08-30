import { beforeEach, describe, expect, it, vi } from 'vitest';

const definitions = vi.hoisted(() => new Map<
  string,
  { id: string; name: string; purpose: 'messaging' }
>());

vi.mock('electron', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-gw-weixin-logout-'));
  return {
    app: { getPath: () => dir },
    powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => false },
  };
});



vi.mock('../../core/storage/index.js', () => ({
  taskDefinitionStore: { get: (id: string) => definitions.get(id) ?? null },
}));

vi.mock('../channels/index.js', () => ({
  registerBuiltinChannels: () => {},
  BUILTIN_CHANNEL_INFOS: [],
}));

import { IMGateway } from '../index.js';
import { channelRegistry } from '../core/registry.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

function config(): MessagingConnectionConfig {
  return {
    id: 'bot-weixin',
    channelType: 'openclaw-weixin',
    name: 'Weixin',
    definitionId: 'td-a',
    appId: '',
    appSecret: '',
  };
}

async function publishAndLogin(gateway: IMGateway): Promise<void> {
  await gateway.publishConfigSnapshot([config()]);
  await gateway.loginWithQrWait('bot-weixin', 'openclaw-weixin');
}

beforeEach(() => {
  definitions.clear();
  definitions.set('td-a', { id: 'td-a', name: 'Task A', purpose: 'messaging' });
  vi.restoreAllMocks();
});

describe('IMGateway Weixin logout orchestration', () => {
  it('waits for stop, then clears credentials and pluginAccountId', async () => {
    const order: string[] = [];
    const localLogout = vi.fn(async () => {
      order.push('clear');
      return { cleared: true, loggedOut: false };
    });
    channelRegistry.register('openclaw-weixin', () => ({
      id: 'openclaw-weixin',
      start: async () => {},
      loginWithQrWait: async () => ({
        connected: true,
        state: 'connected' as const,
        message: 'connected',
        accountId: 'real@im.bot',
      }),
      logoutAccount: localLogout,
    }));
    const gateway = new IMGateway();
    await publishAndLogin(gateway);
    const internal = gateway as unknown as {
      accountManager: { isConnectorQuiescent(botId: string): boolean };
    };
    internal.accountManager.isConnectorQuiescent = () => false;
    vi.spyOn(gateway, 'stopBot').mockImplementation(async () => { order.push('stop'); });

    await expect(gateway.logoutAccount('bot-weixin')).resolves.toMatchObject({ cleared: true });
    expect(order).toEqual(['stop', 'clear']);
    expect(gateway.getBotConfigs()[0].pluginAccountId).toBeUndefined();
  });

  it('does not clear credentials when the stop barrier fails', async () => {
    const localLogout = vi.fn(async () => ({ cleared: true }));
    channelRegistry.register('openclaw-weixin', () => ({
      id: 'openclaw-weixin',
      start: async () => {},
      loginWithQrWait: async () => ({
        connected: true,
        state: 'connected' as const,
        message: 'connected',
        accountId: 'real@im.bot',
      }),
      logoutAccount: localLogout,
    }));
    const gateway = new IMGateway();
    await publishAndLogin(gateway);
    const internal = gateway as unknown as {
      accountManager: { isConnectorQuiescent(botId: string): boolean };
    };
    internal.accountManager.isConnectorQuiescent = () => false;
    vi.spyOn(gateway, 'stopBot').mockRejectedValue(new Error('connector_stop_timeout'));

    await expect(gateway.logoutAccount('bot-weixin')).rejects.toThrow('connector_stop_timeout');
    expect(localLogout).not.toHaveBeenCalled();
    expect(gateway.getBotConfigs()[0].pluginAccountId).toBe('real@im.bot');
  });
});
