import type { Agent } from 'node:http';
import type { Dispatcher } from 'undici';
import type { ProxyProfile } from '../../../shared/types/proxy.js';
import {
  buildUndiciProxyDispatcher,
  createProxyAgent,
} from './proxy-agent-factory.js';

export interface NodeProxyTransportFactories {
  createAgent(profile: ProxyProfile): Agent;
  createDispatcher(profile: ProxyProfile): Dispatcher;
}

export interface NodeProxyTransportLifecycleSnapshot extends Record<string, unknown> {
  agents: number;
  dispatchers: number;
  retiringDispatchers: number;
}

interface CachedTransport<T> {
  fingerprint: string;
  transport: T;
}

const defaultFactories: NodeProxyTransportFactories = {
  createAgent: createProxyAgent,
  createDispatcher: buildUndiciProxyDispatcher,
};

/** Owns reusable Node HTTP transports. Chromium proxying has a separate lifecycle. */
export class NodeProxyTransportRegistry {
  private readonly agents = new Map<string, CachedTransport<Agent>>();
  private readonly dispatchers = new Map<string, CachedTransport<Dispatcher>>();
  private readonly retirements = new Map<Dispatcher, Promise<void>>();

  constructor(private readonly factories: NodeProxyTransportFactories = defaultFactories) {}

  getAgent(profile: ProxyProfile): Agent {
    const fingerprint = transportFingerprint(profile);
    const cached = this.agents.get(profile.id);
    if (cached?.fingerprint === fingerprint) return cached.transport;

    const agent = this.factories.createAgent(profile);
    this.agents.set(profile.id, { fingerprint, transport: agent });
    if (cached) destroyAgent(cached.transport);
    return agent;
  }

  getDispatcher(profile: ProxyProfile): Dispatcher {
    const fingerprint = transportFingerprint(profile);
    const cached = this.dispatchers.get(profile.id);
    if (cached?.fingerprint === fingerprint) return cached.transport;

    const dispatcher = this.factories.createDispatcher(profile);
    this.dispatchers.set(profile.id, { fingerprint, transport: dispatcher });
    if (cached) this.retireDispatcher(cached.transport);
    return dispatcher;
  }

  reconcile(profiles: readonly ProxyProfile[]): void {
    const active = new Map(
      profiles
        .filter((profile) => profile.enabled)
        .map((profile) => [profile.id, transportFingerprint(profile)]),
    );

    for (const [proxyId, cached] of this.agents) {
      if (active.get(proxyId) === cached.fingerprint) continue;
      this.agents.delete(proxyId);
      destroyAgent(cached.transport);
    }
    for (const [proxyId, cached] of this.dispatchers) {
      if (active.get(proxyId) === cached.fingerprint) continue;
      this.dispatchers.delete(proxyId);
      this.retireDispatcher(cached.transport);
    }
  }

  invalidate(proxyId: string): void {
    const agent = this.agents.get(proxyId);
    if (agent) {
      this.agents.delete(proxyId);
      destroyAgent(agent.transport);
    }
    const dispatcher = this.dispatchers.get(proxyId);
    if (dispatcher) {
      this.dispatchers.delete(proxyId);
      this.retireDispatcher(dispatcher.transport);
    }
  }

  async close(): Promise<void> {
    for (const agent of this.agents.values()) destroyAgent(agent.transport);
    this.agents.clear();
    for (const dispatcher of this.dispatchers.values()) {
      this.retireDispatcher(dispatcher.transport);
    }
    this.dispatchers.clear();

    while (this.retirements.size > 0) {
      await Promise.all(this.retirements.values());
    }
  }

  async destroy(): Promise<void> {
    for (const agent of this.agents.values()) destroyAgent(agent.transport);
    this.agents.clear();
    const dispatchers = new Set([
      ...[...this.dispatchers.values()].map(({ transport }) => transport),
      ...this.retirements.keys(),
    ]);
    this.dispatchers.clear();
    await Promise.all([...dispatchers].map((dispatcher) => destroyDispatcher(dispatcher)));
    for (const dispatcher of dispatchers) this.retirements.delete(dispatcher);
  }

  lifecycleSnapshot(): NodeProxyTransportLifecycleSnapshot {
    return {
      agents: this.agents.size,
      dispatchers: this.dispatchers.size,
      retiringDispatchers: this.retirements.size,
    };
  }

  private retireDispatcher(dispatcher: Dispatcher): void {
    if (this.retirements.has(dispatcher)) return;
    const retirement = closeDispatcher(dispatcher);
    this.retirements.set(dispatcher, retirement);
    void retirement.then(() => {
      if (this.retirements.get(dispatcher) === retirement) {
        this.retirements.delete(dispatcher);
      }
    });
  }
}

export function transportFingerprint(profile: ProxyProfile): string {
  return JSON.stringify([
    profile.protocol,
    profile.host,
    profile.port,
    profile.username ?? null,
    profile.password ?? null,
  ]);
}

function destroyAgent(agent: Agent): void {
  try {
    agent.destroy();
  } catch {
    // Node agents expose synchronous teardown; nothing else can safely recover it.
  }
}

async function closeDispatcher(dispatcher: Dispatcher): Promise<void> {
  try {
    await dispatcher.close();
  } catch {
    await destroyDispatcher(dispatcher);
  }
}

async function destroyDispatcher(dispatcher: Dispatcher): Promise<void> {
  await dispatcher.destroy().catch(() => undefined);
}
