import { describe, expect, it, vi } from 'vitest';

import { PilotApplication } from '../pilot-application.js';

function harness(options: { configError?: Error; profileError?: Error } = {}) {
  const order: string[] = [];
  const config = {
    show: vi.fn(async () => ({ revision: 1, environments: { environmentA: {} } })),
    createPatchPlan: vi.fn(async () => ({ id: 'plan-1' })),
    validate: vi.fn(async () => ({ id: 'plan-1' })),
    apply: vi.fn(async () => {
      order.push('delete-config');
      if (options.configError) throw options.configError;
      return { revision: 2 };
    }),
  };
  const browser = {
    deleteUserDataById: vi.fn(async () => {
      order.push('delete-profile');
      if (options.profileError) throw options.profileError;
      return 1;
    }),
  };
  const application = new PilotApplication({
    config,
    environments: {
      getEnvironment: () => ({ id: 'environment-a', userDataId: 'login-profile-a' }),
    },
    browser,
    devices: {},
    screens: {},
    streams: {},
    presentation: {},
  } as never);
  return { application, browser, config, order };
}

describe('PilotApplication BrowserEnvironment cleanup', () => {
  it('deletes only the configured userDataId after the environment definition is removed', async () => {
    const h = harness();

    await h.application.deleteEnvironment('environment-a');

    expect(h.order).toEqual(['delete-config', 'delete-profile']);
    expect(h.browser.deleteUserDataById).toHaveBeenCalledWith('login-profile-a');
  });

  it('reports Profile deletion failure after configuration deletion', async () => {
    const h = harness({ profileError: new Error('disk cleanup failed') });

    await expect(h.application.deleteEnvironment('environment-a')).rejects.toThrow(
      'disk cleanup failed'
    );
    expect(h.order).toEqual(['delete-config', 'delete-profile']);
  });

  it('does not delete the Profile when deleting the environment definition fails', async () => {
    const h = harness({ configError: new Error('config deletion failed') });

    await expect(h.application.deleteEnvironment('environment-a')).rejects.toThrow(
      'config deletion failed'
    );
    expect(h.browser.deleteUserDataById).not.toHaveBeenCalled();
  });
});
