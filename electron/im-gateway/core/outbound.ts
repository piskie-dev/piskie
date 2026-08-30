import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * Outbound — 出站投递队列
 *
 * 把 connector 提供的 deliver 回调包装成 ReplyInterceptor 消费的 dispatcher 形状
 * （sendBlockReply / sendToolResult / sendFinalReply）。逻辑收编自原
 * channel-runtime-adapter.ts 的 createReplyDispatcherWithTyping：
 * - sendChain 串行投递，保证帧序
 * - pending 计数 + markComplete 实现 idle 判定
 * - 空 payload（无文本无媒体）不入队
 */

import type {
  DeliverKind,
  DeliverPayload,
  DispatchCallbacks,
  ReplyDispatcher,
} from './channel-connector.js';

/**
 * DeliveryQueue — 带 sendChain 的内部实现概念：消费者边界统一为
 * ReplyDispatcher，本接口只描述实现对象额外携带的兼容方法，不充当第二套消费边界。
 */
export interface DeliveryQueue extends ReplyDispatcher {
  dispatch(text: string): Promise<void>;
  getFailedCounts(): { block: number; tool: number; final: number };
}

interface DeliveryQueueOptions extends DispatchCallbacks {
  /** 队列完成且无在途帧时通知渠道收尾；迟到帧再次排空时会再次通知。 */
  onIdle?: () => void;
}

export function createDeliveryQueue(callbacks: DeliveryQueueOptions): DeliveryQueue {
  const { deliver, onReplyStart, onError, onIdle } = callbacks;

  let sendChain: Promise<void> = Promise.resolve();
  let pending = 1; // 预留位，由 markComplete 释放
  let completeCalled = false;
  let replyStarted = false;
  const queuedCounts = { block: 0, tool: 0, final: 0 };
  const failedCounts = { block: 0, tool: 0, final: 0 };
  let firstDeliveryError: unknown;
  let deliveryFailureReported = false;

  const notifyIdle = (): void => {
    if (pending !== 0 || !onIdle) return;
    try {
      onIdle();
    } catch {
      /* 渠道收尾异常不改变队列结算。 */
    }
  };

  const enqueue = (kind: DeliverKind, payload: DeliverPayload): boolean => {
    if (
      !payload?.text &&
      !payload?.mediaUrls?.length &&
      !payload?.mediaUrl &&
      !payload?.toolProgress
    ) {
      return false;
    }
    queuedCounts[kind] += 1;
    pending += 1;

    sendChain = sendChain
      .then(async () => {
        if (!replyStarted && onReplyStart) {
          replyStarted = true;
          try {
            await onReplyStart();
          } catch (e) {
            appLog.warn({
              event: 'messaging.reply_start.notify.degraded',
              message: 'Reply start notification degraded',
              context: { scope: 'messaging.reply_start' },
              error: e,
            });
          }
        }
        await deliver(payload, { kind });
      })
      .catch((err: unknown) => {
        failedCounts[kind] += 1;
        firstDeliveryError ??= err;
        if (onError) {
          try {
            onError(err, { kind });
          } catch {
            /* 回调异常不上抛 */
          }
        }
      })
      .finally(() => {
        pending -= 1;
        if (pending === 1 && completeCalled) {
          pending -= 1;
        }
        notifyIdle();
      });

    return true;
  };

  const markComplete = (): void => {
    if (completeCalled) return;
    completeCalled = true;
    void Promise.resolve().then(() => {
      if (pending === 1 && completeCalled) {
        pending -= 1;
        notifyIdle();
      }
    });
  };

  return {
    sendBlockReply: (payload) => enqueue('block', payload),
    sendToolResult: (payload) => enqueue('tool', payload),
    sendFinalReply: (payload) => enqueue('final', payload),
    dispatch: async (text: string) => {
      enqueue('final', { text });
    },
    markComplete,
    waitForIdle: async () => {
      await sendChain;
      const failedReplyCount = failedCounts.tool + failedCounts.block + failedCounts.final;
      if (failedReplyCount > 0 && !deliveryFailureReported) {
        deliveryFailureReported = true;
        appLog.error({
          event: 'messaging.reply.dispatch.failed',
          message: 'Messaging reply delivery failed',
          context: {
            scope: 'messaging.reply',
            failedReplyCount,
            failedToolCount: failedCounts.tool,
            failedBlockCount: failedCounts.block,
            failedFinalCount: failedCounts.final,
          },
          error: firstDeliveryError,
        });
      }
    },
    getQueuedCounts: () => ({ ...queuedCounts }),
    getFailedCounts: () => ({ ...failedCounts }),
  };
}
