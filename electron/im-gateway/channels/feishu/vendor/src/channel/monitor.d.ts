/**
 * PISKIE 手写类型声明（vendor 为编译产物，上游 d.ts 未收编——其类型依赖链
 * 深入 openclaw；此处只声明 index.ts 消费的入口）
 */
export function monitorFeishuProvider(opts: {
  /** OpenClawConfig 形状的配置（channels.feishu.*），vendor getLarkAccount 从中解析 */
  config: Record<string, unknown>;
  /** 日志载体 {log?, error?} */
  runtime?: { log?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  abortSignal?: AbortSignal;
  /** 指定单账号模式（PISKIE 恒传 bot.id） */
  accountId?: string;
}): Promise<void>;
