import { describe, expect, it } from 'vitest';

import type { AgentMcpView } from '../../../../../shared/types/mcp';
import {
  failedMcpServerNames,
  mcpConfigPath,
  mcpServerStateLabel,
} from '../mcpRuntime';

const stateLabels = {
  not_started: '未在此会话启动',
  dormant: '使用时连接',
  starting: '正在连接',
  ready: '已连接',
  failed: '连接失败',
  reconnecting: '正在重连',
  blocked: '需要处理',
  cachedStarting: '目录已缓存 · 正在连接',
  cachedDormant: '目录已缓存 · 使用时连接',
};

function view(overrides: Partial<AgentMcpView> = {}): AgentMcpView {
  return {
    sessionRuntimeId: 'runtime-1',
    total: 2,
    ready: 1,
    starting: 1,
    dormant: 0,
    failed: 0,
    blocked: 0,
    projectionRevision: 1,
    servers: [],
    ...overrides,
  };
}

describe('MCP runtime presentation', () => {
  it('marks cached startup and dormant catalogs without claiming a live connection', () => {
    expect(mcpServerStateLabel({
      name: 'docs',
      state: 'starting',
      transport: 'stdio',
      origin: 'global-explicit',
      catalogSource: 'cache',
      published: true,
    }, stateLabels)).toBe('目录已缓存 · 正在连接');
    expect(mcpServerStateLabel({
      name: 'docs',
      state: 'dormant',
      transport: 'stdio',
      origin: 'global-explicit',
      catalogSource: 'cache',
      published: true,
    }, stateLabels)).toBe('目录已缓存 · 使用时连接');
  });

  it('retries only failed servers that are not explicitly non-retryable', () => {
    expect(failedMcpServerNames(view({
      starting: 0,
      failed: 2,
      servers: [
        { name: 'a', state: 'failed', transport: 'stdio', origin: 'global-explicit', published: true },
        { name: 'b', state: 'failed', transport: 'stdio', origin: 'global-explicit', published: true, retryable: false },
      ],
    }))).toEqual(['a']);
  });

  it('preserves workspace and server identity in the Market route', () => {
    const path = mcpConfigPath('github tools', '/work/my project');
    expect(path).toContain('view=installed');
    expect(path).toContain('kind=mcp');
    expect(path).toContain('query=github+tools');
    expect(path).toContain('workspace=%2Fwork%2Fmy+project');
  });
});
