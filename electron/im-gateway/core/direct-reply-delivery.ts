/**
 * 直接回执运输——唯一的无状态
 * `sendFinalReply -> markComplete -> waitForIdle` 直接运输函数。
 *
 * 命令成功/失败、配置错误和媒体拒绝只传不同 payload，统一返回
 * `kind='direct'`，不复制收尾代码。它直接操作当前渠道创建的
 * ReplyDispatcher：不调用 ReplyInterceptor.setDispatcher()/
 * processStateEvent()/waitForNextYield()，不调用 injectEventToAgent()，
 * 也不伪造 turn_end。业务成功与否由 IMCommandResult.ok/errorCode 表达，
 * 不进入 DispatchResult。
 */

import type { DeliverPayload, DispatchResult, ReplyDispatcher } from './channel-connector.js';
import type { IMCommandResult } from '../commands/command-types.js';

export async function deliverDirectFinalReply(
  payload: DeliverPayload,
  dispatcher: ReplyDispatcher,
): Promise<DispatchResult> {
  try {
    const queued = dispatcher.sendFinalReply(payload);
    if (!queued) throw new Error('Direct response was not queued');
  } finally {
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  }

  return {
    kind: 'direct',
    counts: dispatcher.getQueuedCounts(),
  };
}

export function deliverCommandResultDirect(
  result: IMCommandResult,
  dispatcher: ReplyDispatcher,
): Promise<DispatchResult> {
  return deliverDirectFinalReply(result.directResponse, dispatcher);
}
