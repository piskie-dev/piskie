/**
 * /clear —— 为当前 IM 会话启动一个新的 AgentRun。
 */

import type { IMCommandContext, IMCommandHandler, IMCommandResult, ParsedIMCommand } from './command-types.js';
import { IM_CLEAR_SUCCESS_REPLY } from './command-messages.js';

export class ClearCommandHandler implements IMCommandHandler {
  readonly name = 'clear';

  async execute(
    command: ParsedIMCommand,
    context: IMCommandContext,
  ): Promise<IMCommandResult> {
    if (command.args.length > 0) {
      return {
        handled: true,
        ok: false,
        errorCode: 'invalid_usage',
        directResponse: { text: '用法：/clear' },
      };
    }

    await context.startNewAgent();
    return {
      handled: true,
      ok: true,
      directResponse: { text: IM_CLEAR_SUCCESS_REPLY },
    };
  }
}
