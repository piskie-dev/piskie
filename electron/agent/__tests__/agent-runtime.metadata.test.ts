/**
 * Activation 上下文的浏览器 ID 单一真相源。
 *
 * prepare 曾在 initToolChain 中执行 createToolContext() 并冻结 activation 工具上下文，
 * 早于模块 onStart——BrowserModule.isBrowserMode
 * 未就绪时 getBrowserId() 走 local 分支，`local-{agentId}` 被一次性固化
 * 进 metadata。运行期工具调用以固化 ID 启动并注册浏览器，而 onDestroyBegin/UI 流
 * 订阅/租约用 onStart 后的实时 ID——停止关不掉浏览器（closeBrowser 幂等"成功"成假
 * 凭据）与视频流 not found。
 *
 * 锁定：上下文只能在模块启动后构造；resourceIds 随 activation 冻结，不再靠 getter
 * 绕过错误的生命周期顺序。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test', on: () => undefined },
}));

vi.mock('../../services/paths.service.js', () => ({
  pathsService: {
    getDefaultWorkspaceDir: () => '/tmp/piskie-test/workspace',
    getTempDir: (agentId: string) => `/tmp/piskie/${agentId}`,
    ensureTempDir: vi.fn(),
  },
}));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: { raise: vi.fn(), recover: vi.fn() },
}));

import { AgentRuntime } from '../agent-runtime.js';
import type { AgentSpec } from '../specs/spec.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';

function buildRuntime(): AgentRuntime {
  const spec = {
    name: 'browser-worker',
    role: 'worker',
    modules: ['browser'],
  } as unknown as AgentSpec;
  return new AgentRuntime({
    spec,
    inference: fakeAgentInference(),
    pilotPorts: undefined,
    conversationStore: { append: vi.fn() } as never,
    onStateChange: () => {},
    options: {
      mainAgentId: 'parent-1',
      initialModel: 'p::m',
      subagentConfig: {
        subject: '打开百度',
        taskIds: ['task-baidu'],
        prompt: '打开百度并完成验证。',
        skills: ['browser'],
        mode: 'browser',
      },
    } as never,
  });
}

describe('工具管道 resourceIds：模块启动后冻结', () => {
  it('browser 模块状态就绪后一次取得 browserId，之后保持 activation 快照', () => {
    const runtime = buildRuntime();
    const mod = runtime.getModule('browser') as unknown as {
      isBrowserMode: boolean; browserId?: string;
      getBrowserId(): string;
    };

    // 模拟 onStart 完成：生产 prepare 只会在这之后构造上下文。
    mod.isBrowserMode = true;
    mod.browserId = runtime.id;
    const ctx = (runtime as unknown as {
      createToolContext(): { resourceIds: { browserId?: string } };
    }).createToolContext();

    expect(ctx.resourceIds.browserId).toBe(runtime.id);

    mod.browserId = 'next-activation-browser';
    expect(ctx.resourceIds.browserId).toBe(runtime.id);
  });

  it('Browser Skill 场景（browserEnvironmentId）同样在模块状态就绪后冻结', () => {
    const runtime = buildRuntime();
    const mod = runtime.getModule('browser') as unknown as {
      config: Record<string, unknown>; isBrowserMode: boolean; browserId?: string;
    };
    mod.config = {
      ...mod.config,
      binding: { browserId: 'environment-1', userDataId: 'environment-1' },
    };

    mod.isBrowserMode = true;
    mod.browserId = runtime.id;
    const ctx = (runtime as unknown as {
      createToolContext(): { resourceIds: { browserId?: string } };
    }).createToolContext();
    expect(ctx.resourceIds.browserId).toBe(runtime.id);
  });
});
