import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createImBotsDomain } from '../../../config/domains/im-bots.adapter.js';
import { ConfigDomainRegistry } from '../../../config/core/registry.js';
import { ConfigHost } from '../../../config/host/config-host.js';
import { applyConfigPatch } from '../../../config/host/config-mutations.js';
import {
  ConfigAgentBindings,
  type MessagingConversation,
} from '../../config-agent-bindings.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('ConfigAgentBindings', () => {
  it('serializes concurrent conversations and restores them from im-bots.json', async () => {
    const { host, root } = await fixture();
    const bindings = new ConfigAgentBindings(host);
    const direct = conversation('direct', 'user-1');
    const group = conversation('group', 'group-1');

    await Promise.all([
      bindings.set(direct, 'agent-1'),
      bindings.set(group, 'agent-2'),
    ]);

    const reconstructed = new ConfigAgentBindings(host);
    await expect(reconstructed.get(direct)).resolves.toBe('agent-1');
    await expect(reconstructed.get(group)).resolves.toBe('agent-2');
    await expect(fs.readFile(path.join(root, 'config', 'im-bots.json'), 'utf8'))
      .resolves.toContain('agent-2');
  });

  it('replaces /clear bindings and removes every reference when an AgentRun is deleted', async () => {
    const { host } = await fixture();
    const bindings = new ConfigAgentBindings(host);
    const direct = conversation('direct', 'user-1');
    const group = conversation('group', 'group-1');

    await bindings.set(direct, 'agent-old');
    await bindings.set(direct, 'agent-new');
    await bindings.set(group, 'agent-new');
    await expect(bindings.get(direct)).resolves.toBe('agent-new');

    await bindings.removeAgent('agent-new');
    await expect(bindings.get(direct)).resolves.toBeNull();
    await expect(bindings.get(group)).resolves.toBeNull();
  });

  it('clears a Bot conversation binding when its definition changes', async () => {
    const { host } = await fixture();
    const bindings = new ConfigAgentBindings(host);
    const direct = conversation('direct', 'user-1');
    await bindings.set(direct, 'agent-1');
    const current = await host.show<{ revision: number }>('im-bots');

    await applyConfigPatch(host, 'im-bots', [
      {
        op: 'replace',
        path: '/bots/bot-1/definitionId',
        value: 'td-2',
      },
      {
        op: 'remove',
        path: '/agentBindings/bot-1',
      },
    ], current.revision);

    await expect(bindings.get(direct)).resolves.toBeNull();
  });
});

async function fixture(): Promise<{ host: ConfigHost; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-im-bindings-'));
  temporaryDirectories.push(root);
  const registry = new ConfigDomainRegistry();
  registry.register(createImBotsDomain(
    root,
    {
      validate: () => undefined,
      publish: () => undefined,
      observe: (configs) => configs.map((config) => ({ config, status: 'stopped' })),
    },
    async (domain) => {
      if (domain !== 'task-definitions') throw new Error(`Unexpected dependency: ${domain}`);
      return {
        revision: 0,
        definitions: {
          'td-1': { purpose: 'messaging' },
          'td-2': { purpose: 'messaging' },
        },
      };
    },
  ));
  const host = new ConfigHost(registry);
  await host.initialize();
  await applyConfigPatch(host, 'im-bots', [{
    op: 'add',
    path: '/bots/bot-1',
    value: {
      channelType: 'openclaw-weixin',
      name: 'Bot 1',
      definitionId: 'td-1',
    },
  }], 0);
  return { host, root };
}

function conversation(
  peerKind: MessagingConversation['peerKind'],
  peerId: string,
): MessagingConversation {
  return { botId: 'bot-1', peerKind, peerId };
}
