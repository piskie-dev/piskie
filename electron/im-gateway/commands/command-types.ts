/**
 * IM 命令模块核心类型
 *
 * 命令是独立于普通消息的直接回执路径：不进 Mailbox、不注入 Agent 事件、
 * 不创建 ReplyBinding。业务成功与否由 IMCommandResult.ok/errorCode 表达，
 * 不映射到 DispatchResult 的 Agent 运输结果。
 */

import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';
import type { DeliverPayload, InboundPeer } from '../core/channel-connector.js';

export interface ParsedIMCommand {
  name: string;
  args: string[];
  raw: string;
}

export interface IMCommandContext {
  bot: MessagingConnectionConfig;
  peer: InboundPeer;
  /** 仅用于审计/未来 handler 业务输入，不是核心层二次鉴权依据 */
  senderId: string;
  startNewAgent(): Promise<string>;
}

export type IMCommandResult =
  | {
      handled: true;
      ok: true;
      directResponse: DeliverPayload;
    }
  | {
      handled: true;
      ok: false;
      errorCode: 'invalid_usage' | 'execution_failed';
      directResponse: DeliverPayload;
    };

/** handler 可经构造函数注入 AgentService 等依赖，但不得访问 InboundPipeline 私有状态 */
export interface IMCommandHandler {
  readonly name: string;
  readonly aliases?: readonly string[];
  execute(
    command: ParsedIMCommand,
    context: IMCommandContext,
  ): Promise<IMCommandResult>;
}
