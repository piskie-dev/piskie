import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getEnvironment: vi.fn(),
}));

vi.mock('../../../services/browser-environment-runtime.js', () => ({
  browserEnvironmentRuntime: { getEnvironment: h.getEnvironment },
}));

import { resolveBrowserBinding } from '../browser-binding.js';

const base = {
  mainAgentId: 'main-1',
  workerId: 'worker-1',
};

beforeEach(() => {
  h.getEnvironment.mockReset();
});

describe('resolveBrowserBinding', () => {
  it('uses a unique Worker binding by default', () => {
    expect(resolveBrowserBinding(base)).toEqual({
      browserId: base.workerId,
      userDataId: base.workerId,
    });
  });

  it('shares the Director session binding only when declared by the AgentSpec', () => {
    expect(resolveBrowserBinding({ ...base, shareDirectorBrowser: true })).toEqual({
      browserId: base.mainAgentId,
      userDataId: base.mainAgentId,
    });
  });

  it('gives an explicitly selected environment highest priority', () => {
    h.getEnvironment.mockReturnValue({ id: 'environment-a', userDataId: 'login-a' });

    expect(resolveBrowserBinding({
      ...base,
      browserEnvironmentId: 'environment-a',
      shareDirectorBrowser: true,
    })).toEqual({
      browserId: 'environment-environment-a',
      userDataId: 'login-a',
    });
  });

  it('rejects a deleted explicit environment instead of falling back', () => {
    h.getEnvironment.mockReturnValue(undefined);
    expect(() => resolveBrowserBinding({ ...base, browserEnvironmentId: 'missing' }))
      .toThrow('绑定的浏览器环境不存在或已被删除: missing');
  });
});
