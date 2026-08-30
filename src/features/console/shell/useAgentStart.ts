/**
 * 启动一次运行（「创建入口」的数据侧）。
 *
 * 三个入口共用这一份：左栏 `+` 的任务模板、左栏搜索的 Enter、空态的快捷卡片与 composer。
 *
 * Renderer 只提交统一启动请求；具体模式由 Main 的 Mode Catalog 路由。
 */

import { useCallback } from 'react';

import type { StartAgentRequest } from '../../../../shared/electron-contracts/agents';
import type { TaskDefinitionSnapshot } from '../../../../shared/electron-contracts/task-definitions';
import { useRendererRuntime } from '../../../renderer-runtime/hooks';

export type StartOutcome =
  | { readonly kind: 'started'; readonly agentId: string }
  | {
      readonly kind: 'failed';
      readonly error?: string;
      readonly reason?: 'empty-content';
    };

export interface QuickChatOptions {
  readonly workspace?: string;
  readonly model?: string;
  readonly modeId?: 'normal' | 'plan' | 'browser-skill';
  readonly approvalMode?: 'auto' | 'confirm';
  readonly environmentIds?: readonly string[];
  readonly images?: readonly { data: string; media_type: string }[];
  readonly mcpPrewarmToken?: string;
}

export interface AgentStart {
  /** 启动一个任务模板。 */
  readonly startTaskDefinition: (definition: TaskDefinitionSnapshot) => Promise<StartOutcome>;
  /** 快速聊天：把一句话变成一次运行 */
  readonly startQuickChat: (text: string, options?: QuickChatOptions) => Promise<StartOutcome>;
}

export function useAgentStart(onStarted: (agentId: string) => void): AgentStart {
  const { agentCommands } = useRendererRuntime();

  const startRequest = useCallback(
    async (request: StartAgentRequest): Promise<StartOutcome> => {
      const result = await agentCommands.start(request);
      if (!result.ok) return { kind: 'failed', error: result.error };
      onStarted(result.value);
      return { kind: 'started', agentId: result.value };
    },
    [agentCommands, onStarted],
  );

  const startTaskDefinition = useCallback(
    async (definition: TaskDefinitionSnapshot): Promise<StartOutcome> => {
      return startRequest({
        definitionId: definition.definitionId,
        modeId: definition.defaultModeId,
      });
    },
    [startRequest],
  );

  const startQuickChat = useCallback(
    async (text: string, options?: QuickChatOptions): Promise<StartOutcome> => {
      const message = text.trim();
      if (!message) return { kind: 'failed', reason: 'empty-content' };

      return startRequest({
        modeId: options?.modeId ?? 'normal',
        input: message,
        workspace: options?.workspace,
        approvalMode: options?.approvalMode,
        environmentIds: options?.environmentIds ? [...options.environmentIds] : undefined,
        launchOptions: {
          initialModel: options?.model,
          mcpPrewarmToken: options?.mcpPrewarmToken,
          images: options?.images ? [...options.images] : undefined,
        },
      });
    },
    [startRequest],
  );

  return { startTaskDefinition, startQuickChat };
}
