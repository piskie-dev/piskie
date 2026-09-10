vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sample-app', getAppPath: () => '/tmp/sample-app' } }));
import { specRegistry } from '../../specs/index.js';
import { describe, expect, it, vi } from 'vitest';
import type { PromptContext } from '../types.js';
import { assemble } from '../assemble.js';
import { browserWorkerIdentity, workerIdentity } from '../identities/worker.js';
import { browserSkillBuilderIdentity } from '../browser-skill/builder.js';
import { browserSkillVerifierIdentity } from '../browser-skill/verifier.js';
import { siteScoutIdentity } from '../browser-skill/scout.js';

const ctx: PromptContext = {
  agentId: 'worker-1',
  role: 'worker',
  canManageAgentRuns: false,
  skillDocs: '# Browser',
  workspaceDir: '/workspace',
  tempDir: '/tmp/worker-1',
};

const browserWorkerSpec = specRegistry.get('browser-worker')!;
const localWorkerSpec = specRegistry.get('local-worker')!;

describe('browserWorkerIdentity', () => {
  it.each([
    ['local-worker', workerIdentity],
    ['browser-worker', browserWorkerIdentity],
    ['site-scout', siteScoutIdentity],
    ['browser-skill-builder', browserSkillBuilderIdentity],
    ['browser-skill-verifier', browserSkillVerifierIdentity],
  ] as const)('preserves the complete %s prompt through Worker registration', (name, identity) => {
    expect(specRegistry.get(name)!.buildSystemPrompt(ctx)).toBe(assemble(identity, ctx));
  });

  it('在通用 Worker 提示词后追加浏览器逐次执行要求', () => {
    const prompt = browserWorkerIdentity.render(ctx);

    expect(prompt).toContain(workerIdentity.render(ctx));
    expect(prompt).toContain('## 浏览器执行');
    expect(prompt).toContain(
      'browser_* 工具操作的是 Piskie 为你启动的真实浏览器窗口，用户能看到你的操作。这些调用依赖同一浏览器的页面状态，必须逐次执行；收到当前调用结果后再发起下一次。',
    );
  });

  it('注入所有浏览器 Worker，但不注入 Local Worker', () => {
    expect(browserWorkerSpec.buildSystemPrompt(ctx)).toContain('## 浏览器执行');
    expect(localWorkerSpec.buildSystemPrompt(ctx)).not.toContain('## 浏览器执行');

    for (const identity of [siteScoutIdentity, browserSkillBuilderIdentity, browserSkillVerifierIdentity]) {
      expect(identity.render(ctx)).toContain('## 浏览器执行');
    }
  });
});
