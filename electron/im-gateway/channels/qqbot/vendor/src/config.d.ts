/** PISKIE 手写类型声明（仅 index.ts 消费的入口） */
export function resolveQQBotAccount(cfg: Record<string, unknown>, accountId?: string): {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  clientSecret: string;
  secretSource: string;
  markdownSupport: boolean;
  config: Record<string, unknown>;
};
