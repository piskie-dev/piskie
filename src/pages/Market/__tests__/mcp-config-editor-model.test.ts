import { describe, expect, it } from 'vitest';

import type { McpRegistrySearchResult, McpServerConfig } from '@shared/types/mcp';

import {
  addRegistryEnvironmentHint,
  buildMcpConfig as buildMcpConfigWithLabels,
  mcpConfigPackageIdentity,
  mcpConfigToDraft,
  mcpRegistrySearchQuery,
  registryEnvironmentHints,
} from '../mcp-config-editor-model';

const validationLabels = {
  commandRequired: '要填命令',
  addressRequired: '要填地址',
  addressProtocol: '地址要以 http:// 或 https:// 开头',
  addressInvalid: '地址格式不对',
  environmentVariables: '环境变量',
  requestHeaders: '请求头',
  missingRowName: (label: string, row: number) => `${label}第 ${row} 行没填名称`,
  duplicateRowName: (label: string, name: string) => `${label}里有两个 ${name}`,
};

const buildMcpConfig = (
  draft: Parameters<typeof buildMcpConfigWithLabels>[0],
  base: Parameters<typeof buildMcpConfigWithLabels>[1] = {},
) => buildMcpConfigWithLabels(draft, base, validationLabels);

const context7RegistryResult: McpRegistrySearchResult = {
  name: 'io.github.upstash/context7',
  version: '1.0.31',
  packages: [{
    registryType: 'npm',
    identifier: '@upstash/context7-mcp',
    version: '1.0.31',
    environmentVariables: [{
      name: 'CONTEXT7_API_KEY',
      description: 'API key for authentication',
      format: 'string',
      isSecret: true,
    }],
  }],
};

describe('MCP config editor model', () => {
  it('matches an aliased Context7 config by npm package and exposes its secret API key hint', () => {
    const config: McpServerConfig = {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@1.0.31'],
    };

    expect(mcpConfigPackageIdentity(config)).toEqual({
      kind: 'npm',
      identifier: '@upstash/context7-mcp',
    });
    expect(mcpRegistrySearchQuery('context7')).toBe('context7');
    expect(mcpRegistrySearchQuery('docs', 'io.github.upstash/context7')).toBe('io.github.upstash/context7');
    expect(registryEnvironmentHints([
      {
        name: 'ai.smithery/unrelated-context7',
        packages: [{
          registryType: 'npm',
          identifier: '@other/context7',
          environmentVariables: [{ name: 'WRONG_KEY', isSecret: true }],
        }],
      },
      context7RegistryResult,
    ], 'context7', config)).toEqual([{
      name: 'CONTEXT7_API_KEY',
      description: 'API key for authentication',
      format: 'string',
      secret: true,
      required: false,
    }]);
  });

  it('adds a Registry recommendation once without inventing a placeholder value', () => {
    const hint = registryEnvironmentHints([
      context7RegistryResult,
    ], 'context7', { command: 'npx', args: ['-y', '@upstash/context7-mcp@1.0.31'] })[0]!;

    const once = addRegistryEnvironmentHint([], hint);
    expect(once).toEqual([{ key: 'CONTEXT7_API_KEY', value: '' }]);
    expect(addRegistryEnvironmentHint(once, hint)).toEqual(once);
  });

  it('只覆盖编辑器管的那几项，平台自己的字段原样留着', () => {
    const config: McpServerConfig = {
      command: 'node',
      args: ['server.js', '--safe'],
      cwd: '/repo',
      env: { API_KEY: 'secret', EMPTY_ALLOWED: '' },
      enable_2026_protocol: true,
      enabled: false,
      startup_timeout_sec: 12.5,
      tool_timeout_sec: 90,
      enabled_tools: ['read'],
      disabled_tools: ['delete'],
      supports_parallel_tool_calls: false,
    };

    expect(buildMcpConfig(mcpConfigToDraft(config), config)).toEqual({ success: true, config });
  });

  it('清空环境变量与启用状态时删掉对应字段', () => {
    const config: McpServerConfig = {
      command: 'node',
      env: { API_KEY: 'secret' },
      enabled: false,
    };
    const draft = mcpConfigToDraft(config);
    draft.env = [];
    draft.enabled = true;

    expect(buildMcpConfig(draft, config)).toEqual({
      success: true,
      config: { command: 'node' },
    });
  });

  it('换成远程地址时清掉本机启动那一半', () => {
    const config: McpServerConfig = {
      command: 'node',
      args: ['server.js'],
      cwd: '/repo',
      env: { API_KEY: 'secret' },
      enable_2026_protocol: true,
    };
    const draft = mcpConfigToDraft(config);
    draft.transport = 'streamable_http';
    draft.url = 'https://example.com/mcp';

    expect(buildMcpConfig(draft, config)).toEqual({
      success: true,
      config: { url: 'https://example.com/mcp' },
    });
  });

  it('保留远程一侧编辑器不管的鉴权字段', () => {
    const config: McpServerConfig = {
      url: 'https://example.com/mcp',
      http_headers: { 'X-Tenant': 'piskie' },
      env_http_headers: { Authorization: 'REMOTE_AUTH_HEADER' },
      bearer_token_env_var: 'REMOTE_BEARER_TOKEN',
      oauth: { client_id: 'desktop-client' },
      oauth_resource: 'https://example.com',
      scopes: ['tools.read', 'tools.write'],
      proxyId: 'proxy-global',
    };

    expect(buildMcpConfig(mcpConfigToDraft(config), config)).toEqual({ success: true, config });
  });

  it('远程配置可以清除全局代理引用，切到 stdio 时也不会保留 proxyId', () => {
    const config: McpServerConfig = {
      url: 'https://example.com/mcp',
      proxyId: 'proxy-global',
    };
    const direct = mcpConfigToDraft(config);
    direct.proxyId = '';
    expect(buildMcpConfig(direct, config)).toEqual({
      success: true,
      config: { url: 'https://example.com/mcp' },
    });

    const stdio = mcpConfigToDraft(config);
    stdio.transport = 'stdio';
    stdio.command = 'mcp-server';
    expect(buildMcpConfig(stdio, config)).toEqual({
      success: true,
      config: { command: 'mcp-server' },
    });
  });

  it('地址不合法、请求头重名时都要报错', () => {
    const draft = mcpConfigToDraft({ url: 'https://example.com/mcp' });
    draft.url = 'file:///tmp/mcp';
    draft.httpHeaders = [{ key: 'X-Test', value: 'one' }, { key: 'X-Test', value: 'two' }];

    const result = buildMcpConfig(draft);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toContain('地址要以 http:// 或 https:// 开头');
    expect(result.errors.join('\n')).toContain('请求头里有两个 X-Test');
  });
});
