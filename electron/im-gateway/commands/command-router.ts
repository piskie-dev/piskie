import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * IMCommandRouter——启动时固定注册的有界命令注册表，不是会话状态
 *
 * - 未命中已注册命令返回 null，消息按普通用户文本继续走 Agent 路径
 * - handler 异常在此统一记录完整上下文，并转换为安全的 execution_failed
 *   结果（用户只收到安全失败文案，不泄漏内部错误）
 * - Router 假定 Connector 已完成私聊/群聊成员准入；不读取 sender 信封、
 *   不维护命令 ACL
 */

import { normalizeCommandKey, parseRegisteredCommand } from './command-parser.js';
import type { IMCommandContext, IMCommandHandler, IMCommandResult } from './command-types.js';

export class IMCommandRouter {
  private readonly handlers = new Map<string, IMCommandHandler>();

  constructor(handlers: readonly IMCommandHandler[]) {
    for (const handler of handlers) {
      this.register(handler.name, handler);
      for (const alias of handler.aliases ?? []) {
        this.register(alias, handler);
      }
    }
  }

  private register(name: string, handler: IMCommandHandler): void {
    const key = normalizeCommandKey(name);
    if (this.handlers.has(key)) {
      throw new Error(`Duplicate IM command registration: ${key}`);
    }
    this.handlers.set(key, handler);
  }

  async tryExecute(text: string, context: IMCommandContext): Promise<IMCommandResult | null> {
    const command = parseRegisteredCommand(text, this.handlers);
    if (!command) return null;
    try {
      return await this.handlers.get(command.name)!.execute(command, context);
    } catch (error) {
      appLog.error({
        event: 'messaging.command.dispatch.failed',
        message: 'Messaging command dispatch failed',
        context: {
          scope: 'messaging.command',
          commandName: command.name,
          botId: context.bot.id,
          peerKind: context.peer.kind,
          peerId: context.peer.id,
          senderId: context.senderId,
        },
        error,
      });
      return {
        handled: true,
        ok: false,
        errorCode: 'execution_failed',
        directResponse: { text: '命令执行失败，请稍后重试' },
      };
    }
  }
}
