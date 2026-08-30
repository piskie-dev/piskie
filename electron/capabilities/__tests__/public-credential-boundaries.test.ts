import { describe, expect, it, vi } from 'vitest';
import { ConfigurationApplication } from '../configuration/configuration-application.js';
import { MessagingApplication } from '../messaging/messaging-application.js';
import type { MessagingConnectionConfig, MessagingRuntimeChangedEvent } from '../../../shared/types/im-gateway.js';

const SECRET = 'public-boundary-secret-sentinel';

describe('capability public credential boundaries', () => {
  it('returns Messaging config and events unchanged inside the local trust domain', async () => {
    const config = botConfig();
    let statusListener: ((event: MessagingRuntimeChangedEvent) => void) | undefined;
    const application = new MessagingApplication({
      config: {
        show: vi.fn(async () => ({
          revision: 1,
          bots: { [config.id]: withoutId(config) },
        })),
      } as never,
      gateway: {
        getBotStates: () => [{ config, status: 'running' }],
        statusChanges: {
          subscribe: (listener: (event: MessagingRuntimeChangedEvent) => void) => {
            statusListener = listener;
            return () => undefined;
          },
        },
      } as never,
    });

    const status = await application.status();
    expect(status.configs[0]).toEqual(config);
    expect(JSON.stringify(status)).toContain(SECRET);

    const events: unknown[] = [];
    application.subscribeStatus((event) => events.push(event), new AbortController().signal);
    statusListener?.({ botId: config.id, state: { config, status: 'running' } });
    expect(events).toEqual([{ botId: config.id, state: { config, status: 'running' } }]);
    expect(JSON.stringify(events)).toContain(SECRET);
  });

  it('supports account-login IM channels without application credentials', async () => {
    const config: MessagingConnectionConfig = {
      id: 'bot-account',
      channelType: 'openclaw-weixin',
      name: 'Account Bot',
      definitionId: 'td-1',
    };
    const application = new MessagingApplication({
      config: {
        show: vi.fn(async () => ({
          revision: 1,
          bots: { [config.id]: withoutId(config) },
        })),
      } as never,
      gateway: {
        getBotStates: () => [],
      } as never,
    });

    await expect(application.status()).resolves.toMatchObject({
      configs: [{ id: config.id }],
      botStates: [{ config: { id: config.id }, status: 'stopped' }],
    });
  });

  it('returns the single global proxy fact unchanged inside the local trust domain', async () => {
    const proxy = {
      id: 'proxy-1',
      name: 'Proxy',
      protocol: 'http',
      host: 'proxy.test',
      port: 8080,
      username: 'user',
      password: SECRET,
      enabled: true,
    };
    const storedProxy = withoutId(proxy);
    const application = new ConfigurationApplication({
      host: {
        show: vi.fn(async () => ({ revision: 1, proxies: { [proxy.id]: storedProxy } })),
      } as never,
      settings: {} as never,
      developmentFeatures: true,
    });

    await expect(application.read('proxies')).resolves.toEqual({
      revision: 1,
      proxies: { [proxy.id]: storedProxy },
    });
  });

  it('returns MCP configuration values unchanged inside the local trust domain', async () => {
    const document = {
      revision: 1,
      mcpServers: {
        docs: {
          command: 'docs-server',
          env: { PRIVATE_VALUE: SECRET },
          http_headers: { Authorization: SECRET },
        },
      },
    };
    const application = new ConfigurationApplication({
      host: { show: vi.fn(async () => document) } as never,
      settings: {} as never,
      developmentFeatures: true,
    });

    await expect(application.read('mcp')).resolves.toEqual(document);
  });
});

function botConfig(): MessagingConnectionConfig {
  return {
    id: 'bot-1',
    channelType: 'wecom',
    name: 'Bot',
    definitionId: 'td-1',
    appId: 'app-1',
    appSecret: SECRET,
  };
}

function withoutId<T extends { id: string }>(config: T): Omit<T, 'id'> {
  const value: Partial<T> = { ...config };
  delete value.id;
  return value as Omit<T, 'id'>;
}
