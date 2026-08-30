import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishProxyPoolSnapshot } from '../../storage/proxy-config-store.js';
import {
  createFileProxyFetchResolver,
  resolvePublishedProxyFetch,
  type ProxyFetchResolver,
} from '../proxy-fetch.js';
import { closeConfiguredProxyTransports } from '../proxy-resolver.js';

const fileResolvers: ProxyFetchResolver[] = [];

afterEach(async () => {
  publishProxyPoolSnapshot({ proxies: [] });
  await closeConfiguredProxyTransports();
  await Promise.all(fileResolvers.splice(0).map((resolver) => resolver.close?.()));
});

describe('MCP global proxy fetch adapter', () => {
  it('attaches an undici dispatcher selected from the published global proxy pool', async () => {
    publishProxyPoolSnapshot({ proxies: [{
      id: 'proxy-a',
      name: 'Proxy A',
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'user',
      password: 'plain-password',
      enabled: true,
    }] });
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    const fallback = fetchSpy as typeof fetch;

    await resolvePublishedProxyFetch('proxy-a', fallback)('https://mcp.example.test');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[1]).toHaveProperty('dispatcher');
  });

  it('rejects missing and disabled proxy IDs instead of falling back to direct', () => {
    publishProxyPoolSnapshot({ proxies: [{
      id: 'disabled',
      name: 'Disabled',
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      enabled: false,
    }] });

    expect(() => resolvePublishedProxyFetch('missing', fetch)).toThrow('missing or disabled');
    expect(() => resolvePublishedProxyFetch('disabled', fetch)).toThrow('missing or disabled');
  });

  it('reads CLI proxy facts while ignoring unknown persisted keys without rewriting the file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-mcp-proxy-'));
    const file = path.join(root, 'config', 'proxies.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const original = JSON.stringify({
      revision: 3,
      ignoredRoot: true,
      proxies: {
        'proxy-a': {
          name: 'Proxy A',
          protocol: 'http',
          host: '127.0.0.1',
          port: 8080,
          enabled: true,
          ignoredNested: true,
        },
      },
    });
    await fs.writeFile(file, original);
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    const fallback = fetchSpy as typeof fetch;

    const resolver = createFileProxyFetchResolver(root);
    fileResolvers.push(resolver);
    await resolver('proxy-a', fallback)('https://mcp.example.test');

    expect(fetchSpy.mock.calls[0]?.[1]).toHaveProperty('dispatcher');
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  });

  it('reuses a file-backed dispatcher until the connection profile changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-mcp-proxy-'));
    const file = path.join(root, 'config', 'proxies.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      revision: 0,
      proxies: {
        'proxy-a': {
          name: 'Proxy A',
          protocol: 'http',
          host: '127.0.0.1',
          port: 8080,
          enabled: true,
        },
      },
    }));
    const resolver = createFileProxyFetchResolver(root);
    fileResolvers.push(resolver);
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    const fallback = fetchSpy as typeof fetch;

    await resolver('proxy-a', fallback)('https://mcp.example.test/one');
    await resolver('proxy-a', fallback)('https://mcp.example.test/two');

    expect(fetchSpy.mock.calls[0]?.[1]?.dispatcher)
      .toBe(fetchSpy.mock.calls[1]?.[1]?.dispatcher);
  });
});
