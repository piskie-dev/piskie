import { snapshotTaskDefinition } from '../../agent/launch/agent-run-config-factory.js';
import type { ResolvedAgentLaunch } from '../../agent/launch/resolved-agent-launch.js';
import { directorSpec } from '../../agent/specs/builtin/director.js';
import { taskDefinitionStore } from '../../core/storage/index.js';
import type { AgentRunConfig, TaskDefinition } from '../../../shared/types/index.js';
import { IM_CLEAR_COMMAND_HINT } from '../commands/command-messages.js';
import type { MessagingConversation } from '../config-agent-bindings.js';
import type { MessagingConnectionConfig } from '@shared/types/im-gateway.js';
import type { InboundPeer } from './channel-connector.js';

const IM_BOOTSTRAP_COMMAND_INSTRUCTION = [
  '仅在当前会话的第一次 AI 响应（首次启动 bootstrap）末尾原样追加下面一行：',
  IM_CLEAR_COMMAND_HINT,
  '普通回复中不要重复这条提示，除非用户主动询问可用命令。`/clear` 由 IM 渠道直接处理，不要声称由你执行。',
].join('\n');

export class ImTaskDefinitionUnavailableError extends Error {
  constructor(readonly definitionId?: string) {
    super(definitionId
      ? `Task Definition 不存在: ${definitionId}`
      : 'IM Bot 尚未绑定 Task Definition');
    this.name = 'ImTaskDefinitionUnavailableError';
  }
}

export class ImTaskDefinitionPurposeError extends Error {
  constructor(readonly definitionId: string) {
    super(`Task Definition 不适用于 IM 消息: ${definitionId}`);
    this.name = 'ImTaskDefinitionPurposeError';
  }
}

export interface ResolvedImAgentLaunch {
  conversation: MessagingConversation;
  launch: ResolvedAgentLaunch;
}

export function resolveImAgentLaunch(
  bot: MessagingConnectionConfig,
  peer: InboundPeer,
): ResolvedImAgentLaunch {
  const definitionId = bot.definitionId;
  if (!definitionId) throw new ImTaskDefinitionUnavailableError();
  const definition = taskDefinitionStore.get(definitionId);
  if (!definition) throw new ImTaskDefinitionUnavailableError(definitionId);
  if (definition.purpose !== 'messaging') {
    throw new ImTaskDefinitionPurposeError(definitionId);
  }

  return {
    conversation: {
      botId: bot.id,
      peerKind: peer.kind,
      peerId: peer.id,
    },
    launch: {
      runConfig: buildImRunConfig(definition, bot, peer),
      agentSpec: directorSpec,
      initialModeId: definition.defaultModeId,
      initialApprovalMode: definition.defaultApprovalMode,
    },
  };
}

function buildImRunConfig(
  definition: TaskDefinition,
  bot: MessagingConnectionConfig,
  peer: InboundPeer,
): AgentRunConfig {
  const runConfig = snapshotTaskDefinition(definition);
  const peerLabel = peer.kind === 'group' ? '群' : '私聊';
  runConfig.name = `${definition.name} · ${bot.name} · ${peerLabel} ${peer.id}`;
  runConfig.systemPrompt = runConfig.systemPrompt
    ? `${runConfig.systemPrompt}\n\n${IM_BOOTSTRAP_COMMAND_INSTRUCTION}`
    : IM_BOOTSTRAP_COMMAND_INSTRUCTION;
  return runConfig;
}
