import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../core/storage/index.js', () => ({
  taskDefinitionStore: { get: () => null },
}));

import { OpenClawRuntimeHost } from '../openclaw-runtime-host.js';

type GroupPolicyParams = {
  cfg?: {
    channels?: Record<
      string,
      {
        groupPolicy?: string;
        groups?: Record<string, unknown>;
      }
    >;
  };
  channel?: string;
  groupId?: string;
  groupIdCaseInsensitive?: boolean;
  hasGroupAllowFrom?: boolean;
};

type RuntimeCompatContracts = {
  channel: {
    groups: {
      resolveGroupPolicy(params: GroupPolicyParams): {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig: unknown;
        defaultConfig: unknown;
      };
      resolveRequireMention(
        params: GroupPolicyParams & {
          requireMentionOverride?: boolean;
          overrideOrder?: string;
        }
      ): boolean;
    };
    reply: {
      finalizeInboundContext(
        ctx: Record<string, unknown> | undefined
      ): Record<string, unknown> | undefined;
      formatAgentEnvelope(params: Record<string, unknown>): string;
      withReplyDispatcher(params: {
        run: () => Promise<unknown>;
        dispatcher?: {
          markComplete?(): void;
          waitForIdle?(): Promise<void>;
        };
        onSettled?: () => Promise<void> | void;
      }): Promise<unknown>;
    };
    text: {
      resolveTextChunkLimit(
        config?: Record<string, unknown>,
        provider?: string,
        accountId?: string,
        options?: { fallbackLimit?: number }
      ): number;
    };
  };
};

function contracts(): RuntimeCompatContracts {
  return new OpenClawRuntimeHost('feishu').buildRuntime() as unknown as RuntimeCompatContracts;
}

describe('OpenClaw runtime compatibility contracts', () => {
  it('resolves disabled, wildcard, case-insensitive, and sender-filter group policies', () => {
    const resolve = contracts().channel.groups.resolveGroupPolicy;
    const teamConfig = { requireMention: false };
    const defaultConfig = { requireMention: true };
    const configured = {
      channels: {
        feishu: {
          groupPolicy: 'allowlist',
          groups: { 'Team-A': teamConfig, '*': defaultConfig },
        },
      },
    };

    expect(
      resolve({
        cfg: configured,
        channel: 'feishu',
        groupId: 'team-a',
        groupIdCaseInsensitive: true,
      })
    ).toEqual({
      allowlistEnabled: true,
      allowed: true,
      groupConfig: teamConfig,
      defaultConfig,
    });
    expect(
      resolve({
        cfg: configured,
        channel: 'feishu',
        groupId: 'unlisted',
      })
    ).toEqual({
      allowlistEnabled: true,
      allowed: true,
      groupConfig: undefined,
      defaultConfig,
    });
    expect(
      resolve({
        cfg: { channels: { feishu: { groupPolicy: 'disabled', groups: { '*': {} } } } },
        channel: 'feishu',
        groupId: 'any',
      }).allowed
    ).toBe(false);
    expect(
      resolve({
        cfg: { channels: { feishu: { groupPolicy: 'allowlist' } } },
        channel: 'feishu',
        groupId: 'unlisted',
        hasGroupAllowFrom: true,
      })
    ).toMatchObject({ allowlistEnabled: true, allowed: true });
  });

  it('preserves mention override ordering around group configuration', () => {
    const resolve = contracts().channel.groups.resolveRequireMention;
    const configured = {
      cfg: {
        channels: {
          feishu: {
            groups: { room: { requireMention: false }, '*': { requireMention: true } },
          },
        },
      },
      channel: 'feishu',
      groupId: 'room',
      requireMentionOverride: true,
    };

    expect(resolve(configured)).toBe(false);
    expect(resolve({ ...configured, overrideOrder: 'before-config' })).toBe(true);
    expect(resolve({ ...configured, groupId: 'other' })).toBe(true);
  });

  it('normalizes inbound text, command authorization, and missing media types in place', () => {
    const finalize = contracts().channel.reply.finalizeInboundContext;
    const ctx: Record<string, unknown> = {
      Body: 'body\r\nline',
      CommandBody: 'command\rline',
      CommandAuthorized: 'yes',
      MediaPaths: ['/tmp/a.png', '/tmp/b.png'],
      MediaTypes: [],
    };

    expect(finalize(undefined)).toBeUndefined();
    expect(finalize(ctx)).toBe(ctx);
    expect(ctx).toMatchObject({
      Body: 'body\nline',
      BodyForAgent: 'command\nline',
      BodyForCommands: 'command\rline',
      CommandAuthorized: false,
      MediaType: 'application/octet-stream',
      MediaTypes: ['application/octet-stream', 'application/octet-stream'],
    });
  });

  it('formats a sanitized envelope with elapsed time and an explicitly disabled timestamp', () => {
    const format = contracts().channel.reply.formatAgentEnvelope;

    expect(
      format({
        channel: 'Fei[\nshu]',
        from: ' Alice\r\nOps ',
        host: 'host\nname',
        ip: '127.0.0.1',
        body: 'hello',
        timestamp: new Date(120_000),
        previousTimestamp: new Date(60_000),
        envelope: { includeTimestamp: false },
      })
    ).toBe('[Fei shu Alice Ops +1m host name 127.0.0.1] hello');
  });

  it('settles reply dispatchers in mark, drain, cleanup order after success and failure', async () => {
    const execute = contracts().channel.reply.withReplyDispatcher;
    const calls: string[] = [];
    const dispatcher = {
      markComplete: () => calls.push('complete'),
      waitForIdle: async () => {
        calls.push('idle');
      },
    };
    const onSettled = () => calls.push('settled');

    await expect(
      execute({
        run: async () => {
          calls.push('run');
          return 'ok';
        },
        dispatcher,
        onSettled,
      })
    ).resolves.toBe('ok');
    expect(calls).toEqual(['run', 'complete', 'idle', 'settled']);

    calls.length = 0;
    await expect(
      execute({
        run: async () => {
          calls.push('run');
          throw new Error('failed');
        },
        dispatcher,
        onSettled,
      })
    ).rejects.toThrow('failed');
    expect(calls).toEqual(['run', 'complete', 'idle', 'settled']);
  });

  it('keeps account, channel, and fallback text limits in precedence order', () => {
    const resolve = contracts().channel.text.resolveTextChunkLimit;
    const config = {
      channels: {
        feishu: {
          textChunkLimit: 3000,
          accounts: { bot: { textChunkLimit: 2000 } },
        },
      },
    };

    expect(resolve(config, 'feishu', 'bot', { fallbackLimit: 1000 })).toBe(2000);
    expect(resolve(config, 'feishu', 'other', { fallbackLimit: 1000 })).toBe(3000);
    expect(resolve(config, 'missing', 'bot', { fallbackLimit: 1000 })).toBe(1000);
    expect(resolve(undefined, undefined, undefined, { fallbackLimit: -1 })).toBe(4000);
  });
});
