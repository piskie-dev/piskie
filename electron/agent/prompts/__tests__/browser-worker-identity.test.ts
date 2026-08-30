import { describe, expect, it } from 'vitest';
import type { PromptContext } from '../types.js';
import { browserWorkerIdentity, workerIdentity } from '../identities/worker.js';
import { browserSkillBuilderIdentity } from '../browser-skill/builder.js';
import { browserSkillVerifierIdentity } from '../browser-skill/verifier.js';
import { siteScoutIdentity } from '../browser-skill/scout.js';
import { browserWorkerSpec } from '../../specs/builtin/browser-worker.js';
import { localWorkerSpec } from '../../specs/builtin/local-worker.js';

const ctx: PromptContext = {
  agentId: 'worker-1',
  role: 'worker',
  canManageAgentRuns: false,
  skillDocs: '# Browser',
  workspaceDir: '/workspace',
  tempDir: '/tmp/worker-1',
};

describe('browserWorkerIdentity', () => {
  it('在通用 Worker 提示词后追加浏览器逐次执行要求', () => {
    const prompt = browserWorkerIdentity.render(ctx);

    expect(prompt).toContain(workerIdentity.render(ctx));
    expect(prompt).toContain('## 浏览器执行');
    expect(prompt).toContain(
      'browser 和 Browser Skill 调用依赖同一浏览器的页面状态，必须逐次执行；收到当前调用结果后再发起下一次。',
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
