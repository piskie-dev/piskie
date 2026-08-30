import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { AgentMcpView } from '../../../../../shared/types/mcp';

vi.mock('../../data/mcpRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/mcpRuntime')>();
  return { ...actual, canRetryMcpRuntime: () => false };
});

import { McpRuntimeCard } from '../McpRuntimeCard';

function render(view?: AgentMcpView, variant: 'main' | 'worker' | 'composer' = 'main', error?: string) {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    null,
    createElement(McpRuntimeCard, { view, variant, error, workspace: '/work/repo' }),
  ));
}

describe('McpRuntimeCard', () => {
  it('keeps the failed server visible and folds successful peers by default', () => {
    const markup = render({
      sessionRuntimeId: 'runtime-main',
      total: 2,
      ready: 1,
      starting: 0,
      dormant: 0,
      failed: 1,
      blocked: 0,
      projectionRevision: 2,
      servers: [
        { name: 'context7', state: 'ready', transport: 'stdio', origin: 'global-explicit', published: true },
        {
          name: 'godot-mcp',
          state: 'failed',
          transport: 'stdio',
          origin: 'project-explicit',
          published: false,
          errorSummary: '启动超时',
        },
      ],
    });

    expect(markup).toContain('MCP 连接失败');
    expect(markup).toContain('godot-mcp');
    expect(markup).toContain('启动超时');
    expect(markup).not.toContain('context7');
    expect(markup).toContain('配置');
  });

  it('hides a runtime as soon as every server is connected', () => {
    const markup = render({
      sessionRuntimeId: 'runtime-worker',
      total: 1,
      ready: 1,
      starting: 0,
      dormant: 0,
      failed: 0,
      blocked: 0,
      projectionRevision: 1,
      servers: [
        { name: 'github', state: 'ready', transport: 'stdio', origin: 'global-explicit', published: true },
      ],
    }, 'worker');

    expect(markup).toBe('');
  });

  it('renders one compact line with the servers that are still connecting', () => {
    const markup = render({
      sessionRuntimeId: 'runtime-main',
      total: 3,
      ready: 1,
      starting: 2,
      dormant: 0,
      failed: 0,
      blocked: 0,
      projectionRevision: 1,
      servers: [
        { name: 'context7', state: 'ready', transport: 'stdio', origin: 'global-explicit', published: true },
        {
          name: 'chrome-devtools',
          state: 'starting',
          transport: 'stdio',
          origin: 'global-explicit',
          published: false,
          appliesAt: 'next-boundary',
        },
        { name: 'godot-mcp', state: 'reconnecting', transport: 'stdio', origin: 'project-explicit', published: false },
      ],
    });

    expect(markup).toContain('正在连接 MCP（1/3）');
    expect(markup).toContain('chrome-devtools, godot-mcp');
    expect(markup).not.toContain('context7');
    expect(markup).not.toContain('下一模型边界');
  });

  it('shows a preload adapter failure without manufacturing a ready runtime', () => {
    const markup = render(undefined, 'composer', '预连接入口不可用');
    expect(markup).toContain('MCP 连接失败');
    expect(markup).toContain('预连接入口不可用');
    expect(markup).not.toContain('MCP 已就绪');
  });
});
