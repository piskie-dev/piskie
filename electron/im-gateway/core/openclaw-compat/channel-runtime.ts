/**
 * 上游：openclaw src/channels/typing.ts + src/channels/reply-prefix.ts（MIT）
 * 消费方：feishu vendor card/reply-dispatcher.js
 *
 * createTypingCallbacks：行为等价移植（keepalive 循环与连续失败熔断内联实现，
 * 上游拆在 typing-lifecycle.ts / typing-start-guard.ts 两个小文件里）。
 * createReplyPrefixContext：PISKIE 简化——上游依赖 agents/identity 与渠道插件注册表
 * 解析 identityName/responsePrefix；PISKIE 配置（仅 channels 段）下这些解析恒为
 * undefined，此处直接返回等效结果，保留 onModelSelected 的原位变更语义。
 */

export type TypingCallbacks = {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void;
  /** Called when the typing controller is cleaned up (e.g. on NO_REPLY). */
  onCleanup?: () => void;
};

export type CreateTypingCallbacksParams = {
  start: () => Promise<void>;
  stop?: () => Promise<void>;
  onStartError: (err: unknown) => void;
  onStopError?: (err: unknown) => void;
  keepaliveIntervalMs?: number;
  /** Stop keepalive after this many consecutive start() failures. Default: 2 */
  maxConsecutiveFailures?: number;
  /** Maximum duration for typing indicator before auto-cleanup (safety TTL). Default: 60s */
  maxDurationMs?: number;
};

export function createTypingCallbacks(params: CreateTypingCallbacksParams): TypingCallbacks {
  const stop = params.stop;
  const keepaliveIntervalMs = params.keepaliveIntervalMs ?? 3_000;
  const maxConsecutiveFailures = Math.max(1, params.maxConsecutiveFailures ?? 2);
  const maxDurationMs = params.maxDurationMs ?? 60_000;
  let stopSent = false;
  let closed = false;
  let consecutiveFailures = 0;
  let tripped = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;

  const stopKeepalive = () => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
  };

  const fireStart = async (): Promise<void> => {
    if (closed || tripped) return;
    try {
      await params.start();
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      params.onStartError(err);
      if (consecutiveFailures >= maxConsecutiveFailures) {
        tripped = true;
        stopKeepalive();
      }
    }
  };

  const clearTtlTimer = () => {
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = undefined;
    }
  };

  const startTtlTimer = () => {
    if (maxDurationMs <= 0) return;
    clearTtlTimer();
    ttlTimer = setTimeout(() => {
      if (!closed) {
        console.warn(`[typing] TTL exceeded (${maxDurationMs}ms), auto-stopping typing indicator`);
        fireStop();
      }
    }, maxDurationMs);
  };

  const onReplyStart = async () => {
    if (closed) return;
    stopSent = false;
    consecutiveFailures = 0;
    tripped = false;
    stopKeepalive();
    clearTtlTimer();
    await fireStart();
    if (tripped) return;
    keepaliveTimer = setInterval(() => {
      void fireStart();
    }, keepaliveIntervalMs);
    startTtlTimer();
  };

  const fireStop = () => {
    closed = true;
    stopKeepalive();
    clearTtlTimer();
    if (!stop || stopSent) return;
    stopSent = true;
    void stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
  };

  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}

// ── reply-prefix ──────────────────────────────────────────────────────────

export type ResponsePrefixContext = {
  identityName?: string;
  provider?: string;
  model?: string;
  modelFull?: string;
  thinkingLevel?: string;
};

type ModelSelectionContext = {
  provider: string;
  model: string;
  thinkLevel?: string;
};

export type ReplyPrefixContextBundle = {
  prefixContext: ResponsePrefixContext;
  responsePrefix?: string;
  enableSlackInteractiveReplies?: boolean;
  responsePrefixContextProvider: () => ResponsePrefixContext;
  onModelSelected: (ctx: ModelSelectionContext) => void;
};

/** 提取模型短名（上游 response-prefix-template.ts 的 extractShortModelName） */
function extractShortModelName(model: string): string {
  const parts = model.split('/');
  return parts[parts.length - 1] ?? model;
}

export function createReplyPrefixContext(_params: {
  cfg: Record<string, unknown>;
  agentId: string;
  channel?: string;
  accountId?: string;
}): ReplyPrefixContextBundle {
  const prefixContext: ResponsePrefixContext = {
    identityName: undefined,
  };

  const onModelSelected = (ctx: ModelSelectionContext) => {
    // Mutate the object directly instead of reassigning to ensure closures see updates.
    prefixContext.provider = ctx.provider;
    prefixContext.model = extractShortModelName(ctx.model);
    prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
    prefixContext.thinkingLevel = ctx.thinkLevel ?? 'off';
  };

  return {
    prefixContext,
    responsePrefix: undefined,
    enableSlackInteractiveReplies: undefined,
    responsePrefixContextProvider: () => prefixContext,
    onModelSelected,
  };
}
