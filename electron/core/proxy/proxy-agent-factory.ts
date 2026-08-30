/**
 * 代理 Agent 工厂
 * 根据代理配置创建 Node.js http.Agent 实例（用于 http.get 等场景）
 * 以及 undici Dispatcher（用于 SDK fetch 场景）
 */

import type { Agent } from 'http';
import { isIP, type Socket } from 'node:net';
import * as tls from 'tls';
import { ProxyAgent as UndiciProxyAgent, Agent as UndiciAgent } from 'undici';
import type { buildConnector, Dispatcher } from 'undici';
import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ProxyProfile } from '../../../shared/types/proxy.js';

type SocksConnectorDependencies = {
  createConnection: typeof SocksClient.createConnection;
  connectTls: typeof tls.connect;
};

const defaultSocksConnectorDependencies: SocksConnectorDependencies = {
  createConnection: SocksClient.createConnection.bind(SocksClient),
  connectTls: tls.connect,
};

export function buildNodeProxyUrl(profile: ProxyProfile): URL {
  const url = new URL(`${profile.protocol}://proxy.invalid`);
  const host = normalizeProxyHost(profile.host);
  url.hostname = host;
  url.port = String(profile.port);
  if (profile.username !== undefined) url.username = profile.username;
  if (profile.password !== undefined) url.password = profile.password;
  return url;
}

/**
 * 根据 ProxyProfile 创建对应协议的 http.Agent（用于 http.get 等原生 Node 场景）
 */
export function createProxyAgent(profile: ProxyProfile): Agent {
  const proxyUrl = buildNodeProxyUrl(profile);

  if (profile.protocol === 'socks5') {
    return new SocksProxyAgent(proxyUrl);
  }
  return new HttpsProxyAgent(proxyUrl);
}

/**
 * 根据 ProxyProfile 创建 undici Dispatcher（用于 SDK fetch 场景）
 * OpenAI SDK v6 / Anthropic SDK 新版通过 fetchOptions.dispatcher 传入
 */
export function buildUndiciProxyDispatcher(profile: ProxyProfile): Dispatcher {
  if (profile.protocol === 'socks5') {
    return new UndiciAgent({
      connect: buildSocks5Connector(profile),
    });
  }

  return new UndiciProxyAgent(buildNodeProxyUrl(profile).href);
}

export function buildSocks5Connector(
  profile: ProxyProfile,
  dependencies: SocksConnectorDependencies = defaultSocksConnectorDependencies,
): buildConnector.connector {
  return (options, callback) => {
    let completed = false;
    const succeed = (socket: Socket | tls.TLSSocket): void => {
      if (completed) return;
      completed = true;
      callback(null, socket);
    };
    const fail = (error: Error): void => {
      if (completed) return;
      completed = true;
      callback(error, null);
    };
    const port = targetPort(options.protocol, options.port);

    void dependencies.createConnection({
      proxy: {
        host: profile.host,
        port: profile.port,
        type: 5,
        userId: profile.username,
        password: profile.password,
      },
      command: 'connect',
      destination: {
        host: options.hostname,
        port,
      },
    }).then(({ socket }) => {
      if (options.protocol !== 'https:') {
        succeed(socket);
        return;
      }

      let tlsSocket: tls.TLSSocket;
      try {
        tlsSocket = dependencies.connectTls({
          socket,
          servername: options.servername
            ?? (isIP(options.hostname) === 0 ? options.hostname : undefined),
        });
      } catch (cause) {
        socket.destroy();
        fail(cause instanceof Error ? cause : new Error(String(cause)));
        return;
      }
      const onTlsError = (error: Error): void => {
        tlsSocket.destroy();
        fail(error);
      };
      tlsSocket.once('error', onTlsError);
      tlsSocket.once('secureConnect', () => {
        tlsSocket.off('error', onTlsError);
        succeed(tlsSocket);
      });
    }).catch((cause: unknown) => {
      fail(cause instanceof Error ? cause : new Error(String(cause)));
    });
  };
}

function normalizeProxyHost(host: string): string {
  const bracketed = host.startsWith('[') && host.endsWith(']');
  const candidate = bracketed ? host.slice(1, -1) : host;
  if (isIP(candidate) === 6) return `[${candidate}]`;
  if (bracketed || /[\s:/\\@?#[\]]/.test(candidate)) {
    throw new Error(`Invalid proxy host: ${host}`);
  }

  const probe = new URL('http://proxy.invalid');
  probe.hostname = candidate;
  if (probe.hostname === 'proxy.invalid' && candidate.toLowerCase() !== 'proxy.invalid') {
    throw new Error(`Invalid proxy host: ${host}`);
  }
  return candidate;
}

function targetPort(protocol: string, port: string): number {
  const parsed = Number(port);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : protocol === 'https:' ? 443 : 80;
}
