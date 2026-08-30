/**
 * PISKIE 手写类型声明（仅 index.ts 消费的静态方法）
 */
export class LarkClient {
  /** 注入 openclaw runtime 宿主对象（PISKIE 侧为 FeishuRuntimeHost.buildRuntime()） */
  static setRuntime(runtime: Record<string, unknown>): void;
  /** 停止账号时清理缓存的 client/WS 实例 */
  static clearCache(accountId?: string): Promise<void>;
}
