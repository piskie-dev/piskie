/**
 * 代理配置共享类型定义
 * 全局代理池，供浏览器代理和 AI API 代理共用
 */

export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface ProxyProfile {
  id: string;              // UUID
  name: string;            // 用户命名，如"日本节点"
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  enabled: boolean;
}

export interface ProxyPoolSnapshot {
  proxies: ProxyProfile[];
}

export interface ProxyProbeResult {
  reachable: boolean;
  latencyMs?: number;
  error?: string;
  externalIp?: string;
}
