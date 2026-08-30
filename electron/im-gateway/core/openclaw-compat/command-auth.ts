/**
 * 上游：openclaw src/plugin-sdk/command-auth.ts（MIT，仅移植 weixin 消费的两个函数）
 * 消费方：weixin vendor messaging/process-message.ts
 * 核心逻辑复用 ./zalouser.ts（同一上游模块的另一入口名）
 */

import {
  resolveSenderCommandAuthorization,
  type ResolveSenderCommandAuthorizationParams,
} from './zalouser.js';

export { resolveSenderCommandAuthorization } from './zalouser.js';

export type CommandAuthorizationRuntime = {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: unknown) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
};

/** Runtime-backed wrapper around sender command authorization for grouped helper surfaces. */
export async function resolveSenderCommandAuthorizationWithRuntime(
  params: Omit<
    ResolveSenderCommandAuthorizationParams,
    'shouldComputeCommandAuthorized' | 'resolveCommandAuthorizedFromAuthorizers'
  > & { runtime: CommandAuthorizationRuntime },
): ReturnType<typeof resolveSenderCommandAuthorization> {
  return resolveSenderCommandAuthorization({
    ...params,
    shouldComputeCommandAuthorized: params.runtime.shouldComputeCommandAuthorized,
    resolveCommandAuthorizedFromAuthorizers: params.runtime.resolveCommandAuthorizedFromAuthorizers,
  });
}

/** Fast-path DM command authorization when only policy and sender allowlist state matter. */
export function resolveDirectDmAuthorizationOutcome(params: {
  isGroup: boolean;
  dmPolicy: string;
  senderAllowedForCommands: boolean;
}): 'disabled' | 'unauthorized' | 'allowed' {
  if (params.isGroup) {
    return 'allowed';
  }
  if (params.dmPolicy === 'disabled') {
    return 'disabled';
  }
  if (params.dmPolicy !== 'open' && !params.senderAllowedForCommands) {
    return 'unauthorized';
  }
  return 'allowed';
}
