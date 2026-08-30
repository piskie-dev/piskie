/**
 * PISKIE 手写类型声明（vendor 为编译产物，上游 d.ts 类型链未收编；仅声明 index.ts 消费的入口）
 */
export function startGateway(ctx: {
  account: {
    accountId: string;
    appId: string;
    clientSecret: string;
    enabled: boolean;
    name?: string;
    markdownSupport?: boolean;
    config: Record<string, unknown>;
  };
  abortSignal?: AbortSignal;
  cfg: Record<string, unknown>;
  log?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  onReady?: () => void;
  onError?: (error: Error) => void;
}): Promise<void>;
