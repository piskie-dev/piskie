import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const state = await vi.hoisted(async () => {
  const os = await import('node:os');
  const fsModule = await import('node:fs');
  const pathModule = await import('node:path');
  const stateDir = fsModule.mkdtempSync(pathModule.join(os.tmpdir(), 'weixin-logout-test-'));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return { stateDir };
});



vi.mock('../../../../core/storage/index.js', () => ({
  taskDefinitionStore: { get: vi.fn(() => null) },
}));

import { createWeixinConnector } from '../index.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';

function bot(overrides: Partial<MessagingConnectionConfig> = {}): MessagingConnectionConfig {
  return {
    id: 'bot-logout',
    name: 'Weixin',
    channelType: 'openclaw-weixin',
    definitionId: 'td-1',
    appId: '',
    appSecret: '',
    ...overrides,
  };
}

beforeEach(() => {
  fs.rmSync(state.stateDir, { recursive: true, force: true });
  fs.mkdirSync(state.stateDir, { recursive: true });
});

describe('Weixin local logout', () => {
  it('clears normalized/raw account files, context, sync cursor and account index', async () => {
    const accountDir = path.join(state.stateDir, 'openclaw-weixin', 'accounts');
    fs.mkdirSync(accountDir, { recursive: true });
    for (const suffix of ['.json', '.sync.json', '.context-tokens.json']) {
      fs.writeFileSync(path.join(accountDir, `real@im.bot${suffix}`), '{}', 'utf8');
    }
    fs.writeFileSync(
      path.join(state.stateDir, 'openclaw-weixin', 'accounts.json'),
      JSON.stringify(['real@im.bot']),
      'utf8',
    );

    const connector = createWeixinConnector(bot({ pluginAccountId: 'real@im.bot' }));
    await expect(connector.logoutAccount?.({ accountId: 'bot-logout' }))
      .resolves.toMatchObject({ cleared: true });

    expect(fs.readdirSync(accountDir)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(
      path.join(state.stateDir, 'openclaw-weixin', 'accounts.json'),
      'utf8',
    ))).toEqual([]);
  });

  it('clears the legacy credential and sync cursor only when they are the credential source', async () => {
    const credential = path.join(
      state.stateDir,
      'credentials',
      'openclaw-weixin',
      'credentials.json',
    );
    const legacySync = path.join(
      state.stateDir,
      'agents',
      'default',
      'sessions',
      '.openclaw-weixin-sync',
      'default.json',
    );
    fs.mkdirSync(path.dirname(credential), { recursive: true });
    fs.mkdirSync(path.dirname(legacySync), { recursive: true });
    fs.writeFileSync(credential, JSON.stringify({ token: 'legacy' }), 'utf8');
    fs.writeFileSync(legacySync, JSON.stringify({ get_updates_buf: 'cursor' }), 'utf8');

    const connector = createWeixinConnector(bot());
    await connector.logoutAccount?.({ accountId: 'bot-logout' });
    expect(fs.existsSync(credential)).toBe(false);
    expect(fs.existsSync(legacySync)).toBe(false);
  });
});
