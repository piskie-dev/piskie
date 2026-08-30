import type { Agent } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { Dispatcher } from 'undici';
import type { ProxyProfile } from '../../../../shared/types/proxy.js';
import {
  NodeProxyTransportRegistry,
  transportFingerprint,
} from '../node-proxy-transport-registry.js';

function profile(overrides: Partial<ProxyProfile> = {}): ProxyProfile {
  return {
    id: 'proxy-one',
    name: 'Proxy one',
    protocol: 'http',
    host: '127.0.0.1',
    port: 8080,
    enabled: true,
    ...overrides,
  };
}

function fakeAgent(): Agent & { destroy: ReturnType<typeof vi.fn> } {
  return { destroy: vi.fn() } as unknown as Agent & { destroy: ReturnType<typeof vi.fn> };
}

function fakeDispatcher(options: { closeError?: Error } = {}): Dispatcher & {
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  return {
    close: vi.fn(async () => {
      if (options.closeError) throw options.closeError;
    }),
    destroy: vi.fn(async () => undefined),
  } as unknown as Dispatcher & {
    close: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
}

describe('NodeProxyTransportRegistry', () => {
  it('reuses each transport for an unchanged connection profile', async () => {
    const agent = fakeAgent();
    const dispatcher = fakeDispatcher();
    const factories = {
      createAgent: vi.fn(() => agent),
      createDispatcher: vi.fn(() => dispatcher),
    };
    const registry = new NodeProxyTransportRegistry(factories);
    const configured = profile();

    expect(registry.getAgent(configured)).toBe(agent);
    expect(registry.getAgent({ ...configured, name: 'Renamed', enabled: false })).toBe(agent);
    expect(registry.getDispatcher(configured)).toBe(dispatcher);
    expect(registry.getDispatcher({ ...configured, name: 'Renamed' })).toBe(dispatcher);
    expect(factories.createAgent).toHaveBeenCalledOnce();
    expect(factories.createDispatcher).toHaveBeenCalledOnce();

    await registry.close();
  });

  it('replaces changed resources only after their replacement was created', async () => {
    const oldAgent = fakeAgent();
    const nextAgent = fakeAgent();
    const oldDispatcher = fakeDispatcher();
    const nextDispatcher = fakeDispatcher();
    const factories = {
      createAgent: vi.fn()
        .mockReturnValueOnce(oldAgent)
        .mockImplementationOnce(() => { throw new Error('agent factory failed'); })
        .mockReturnValueOnce(nextAgent),
      createDispatcher: vi.fn()
        .mockReturnValueOnce(oldDispatcher)
        .mockReturnValueOnce(nextDispatcher),
    };
    const registry = new NodeProxyTransportRegistry(factories);
    const original = profile();
    const changed = profile({ password: 'new-password' });
    registry.getAgent(original);
    registry.getDispatcher(original);

    expect(() => registry.getAgent(changed)).toThrow('agent factory failed');
    expect(registry.getAgent(original)).toBe(oldAgent);
    expect(oldAgent.destroy).not.toHaveBeenCalled();

    expect(registry.getAgent(changed)).toBe(nextAgent);
    expect(registry.getDispatcher(changed)).toBe(nextDispatcher);
    expect(oldAgent.destroy).toHaveBeenCalledOnce();
    expect(oldDispatcher.close).toHaveBeenCalledOnce();

    await registry.close();
  });

  it('reconciles removed or disabled profiles and falls back to destroy after close failure', async () => {
    const agent = fakeAgent();
    const dispatcher = fakeDispatcher({ closeError: new Error('close failed') });
    const registry = new NodeProxyTransportRegistry({
      createAgent: () => agent,
      createDispatcher: () => dispatcher,
    });
    const configured = profile();
    registry.getAgent(configured);
    registry.getDispatcher(configured);

    registry.reconcile([{ ...configured, enabled: false }]);
    await registry.close();

    expect(agent.destroy).toHaveBeenCalledOnce();
    expect(dispatcher.close).toHaveBeenCalledOnce();
    expect(dispatcher.destroy).toHaveBeenCalledOnce();
    expect(registry.lifecycleSnapshot()).toEqual({
      agents: 0,
      dispatchers: 0,
      retiringDispatchers: 0,
    });
  });

  it('is idempotent and can be reused after closing', async () => {
    const agents = [fakeAgent(), fakeAgent()];
    const dispatchers = [fakeDispatcher(), fakeDispatcher()];
    const registry = new NodeProxyTransportRegistry({
      createAgent: vi.fn(() => agents.shift()!),
      createDispatcher: vi.fn(() => dispatchers.shift()!),
    });
    const configured = profile();
    const firstAgent = registry.getAgent(configured);
    const firstDispatcher = registry.getDispatcher(configured);

    await Promise.all([registry.close(), registry.close()]);
    expect(registry.getAgent(configured)).not.toBe(firstAgent);
    expect(registry.getDispatcher(configured)).not.toBe(firstDispatcher);
    await registry.close();
  });

  it('force-destroys a dispatcher without waiting for a stuck graceful close', async () => {
    const dispatcher = fakeDispatcher();
    dispatcher.close.mockImplementation(() => new Promise<void>(() => undefined));
    const registry = new NodeProxyTransportRegistry({
      createAgent: () => fakeAgent(),
      createDispatcher: () => dispatcher,
    });
    registry.getDispatcher(profile());
    registry.invalidate('proxy-one');

    await registry.destroy();

    expect(dispatcher.destroy).toHaveBeenCalledOnce();
    expect(registry.lifecycleSnapshot().retiringDispatchers).toBe(0);
  });

  it('uses an unambiguous transport fingerprint', () => {
    expect(transportFingerprint(profile({ username: 'a:b', password: 'c' })))
      .not.toBe(transportFingerprint(profile({ username: 'a', password: 'b:c' })));
    expect(transportFingerprint(profile({ protocol: 'http' })))
      .not.toBe(transportFingerprint(profile({ protocol: 'https' })));
  });
});
