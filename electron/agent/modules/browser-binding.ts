import { browserEnvironmentRuntime } from '../../services/browser-environment-runtime.js';

export interface ResolvedBrowserBinding {
  readonly browserId: string;
  readonly userDataId: string;
}

export function resolveBrowserBinding(input: {
  mainAgentId: string;
  workerId: string;
  browserEnvironmentId?: string;
  shareDirectorBrowser?: boolean;
}): ResolvedBrowserBinding {
  if (input.browserEnvironmentId) {
    const environment = browserEnvironmentRuntime.getEnvironment(input.browserEnvironmentId);
    if (!environment) {
      throw new Error(`绑定的浏览器环境不存在或已被删除: ${input.browserEnvironmentId}`);
    }
    return Object.freeze({
      browserId: `environment-${environment.id}`,
      userDataId: environment.userDataId ?? environment.id,
    });
  }

  const resourceId = input.shareDirectorBrowser
    ? input.mainAgentId
    : input.workerId;
  return Object.freeze({ browserId: resourceId, userDataId: resourceId });
}
