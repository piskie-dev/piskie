import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import type { buildConnector } from 'undici';
import type { ProxyProfile } from '../../../../shared/types/proxy.js';
import {
  buildNodeProxyUrl,
  buildSocks5Connector,
  createProxyAgent,
} from '../proxy-agent-factory.js';

function profile(overrides: Partial<ProxyProfile> = {}): ProxyProfile {
  return {
    id: 'proxy-one',
    name: 'Proxy one',
    protocol: 'http',
    host: 'proxy.example.test',
    port: 8080,
    enabled: true,
    ...overrides,
  };
}

describe('Node proxy URL construction', () => {
  it('encodes credentials independently without changing their values', () => {
    const url = buildNodeProxyUrl(profile({
      username: 'user:name@example/#',
      password: 'pass:@/#',
    }));

    expect(decodeURIComponent(url.username)).toBe('user:name@example/#');
    expect(decodeURIComponent(url.password)).toBe('pass:@/#');
    expect(url.href).not.toContain('user:name@example/#');
  });

  it('preserves one-sided credentials, HTTPS proxy transport, and IPv6 hosts', () => {
    const usernameOnly = buildNodeProxyUrl(profile({ username: 'user', password: undefined }));
    const passwordOnly = buildNodeProxyUrl(profile({ username: undefined, password: 'secret' }));
    const ipv6 = buildNodeProxyUrl(profile({
      protocol: 'https',
      host: '2001:db8::1',
      port: 8443,
    }));
    const httpsAgent = createProxyAgent(profile({ protocol: 'https' }));

    expect(usernameOnly.username).toBe('user');
    expect(usernameOnly.password).toBe('');
    expect(passwordOnly.username).toBe('');
    expect(passwordOnly.password).toBe('secret');
    expect(ipv6.href).toBe('https://[2001:db8::1]:8443/');
    expect(httpsAgent).toMatchObject({ proxy: { protocol: 'https:' } });
    httpsAgent.destroy();
  });

  it('rejects host text that could escape the URL authority', () => {
    expect(() => buildNodeProxyUrl(profile({ host: 'proxy.example.test@other.test' })))
      .toThrow('Invalid proxy host');
    expect(() => buildNodeProxyUrl(profile({ host: 'proxy.example.test/path' })))
      .toThrow('Invalid proxy host');
  });
});

describe('SOCKS5 undici connector', () => {
  it('uses protocol-specific default target ports', async () => {
    const socket = new Socket();
    const createConnection = vi.fn(async () => ({ socket }));
    const callback = vi.fn();
    const connector = buildSocks5Connector(profile({ protocol: 'socks5' }), {
      createConnection: createConnection as never,
      connectTls: vi.fn() as never,
    });

    connector(options({ protocol: 'http:', port: '' }), callback as buildConnector.Callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());

    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({
      destination: { host: 'service.example.test', port: 80 },
    }));
    socket.destroy();
  });

  it('waits for TLS secureConnect and omits SNI for an IP target', async () => {
    const socket = new Socket();
    const tlsSocket = fakeTlsSocket();
    const createConnection = vi.fn(async () => ({ socket }));
    const connectTls = vi.fn(() => tlsSocket);
    const callback = vi.fn();
    const connector = buildSocks5Connector(profile({ protocol: 'socks5' }), {
      createConnection: createConnection as never,
      connectTls: connectTls as never,
    });

    connector(options({ hostname: '127.0.0.1', protocol: 'https:', port: '' }),
      callback as buildConnector.Callback);
    await vi.waitFor(() => expect(connectTls).toHaveBeenCalledOnce());
    expect(callback).not.toHaveBeenCalled();
    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({
      destination: { host: '127.0.0.1', port: 443 },
    }));
    expect(connectTls).toHaveBeenCalledWith(expect.objectContaining({ servername: undefined }));

    tlsSocket.emit('secureConnect');
    expect(callback).toHaveBeenCalledWith(null, tlsSocket);
    socket.destroy();
  });

  it('reports a TLS failure once and destroys its socket', async () => {
    const socket = new Socket();
    const tlsSocket = fakeTlsSocket();
    const createConnection = vi.fn(async () => ({ socket }));
    const callback = vi.fn();
    const connector = buildSocks5Connector(profile({ protocol: 'socks5' }), {
      createConnection: createConnection as never,
      connectTls: vi.fn(() => tlsSocket) as never,
    });
    const error = new Error('TLS failed');

    connector(options({ protocol: 'https:', port: '9443', servername: 'api.example.test' }),
      callback as buildConnector.Callback);
    await vi.waitFor(() => expect(tlsSocket.listenerCount('error')).toBe(1));
    tlsSocket.emit('error', error);
    tlsSocket.emit('secureConnect');

    expect(tlsSocket.destroy).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(error, null);
    socket.destroy();
  });
});

function options(
  overrides: Partial<buildConnector.Options> = {},
): buildConnector.Options {
  return {
    hostname: 'service.example.test',
    protocol: 'https:',
    port: '443',
    ...overrides,
  };
}

function fakeTlsSocket(): TLSSocket & { destroy: ReturnType<typeof vi.fn> } {
  const socket = new EventEmitter() as TLSSocket & { destroy: ReturnType<typeof vi.fn> };
  socket.destroy = vi.fn(() => socket);
  return socket;
}
