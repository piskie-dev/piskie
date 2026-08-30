/**
 * useComposerSettings —— 输入区设置控件的**回写逻辑**（模型 / 思考 / 计划 / 审批）。
 *
 * 这些回写的唯一住所：全是 store 分发（agent 级 / worker 级两条通道），呈现层不掺业务。
 */

import { useCallback, useMemo } from 'react';

import type { ApprovalMode, AgentModeId } from '../../../../../shared/types';
import type { ReasoningSelection } from '../../../../../shared/types/reasoning';
import {
  getAvailableModelOptions,
  useInferenceStore,
  type ModelOptGroup,
} from '../../../../store/inferenceStore';
import { useRendererRuntime } from '../../../../renderer-runtime/hooks';

export interface ComposerSettings {
  readonly modelGroups: ModelOptGroup[];
  readonly onModelChange: (next: string) => Promise<void>;
  readonly onReasoningChange: (selection?: ReasoningSelection) => Promise<void>;
  /** 仅主 Agent 可切换 Catalog 允许的运行时模式；Worker 上是空操作。 */
  readonly onModeChange: (next: AgentModeId) => Promise<void>;
  readonly onApprovalModeChange: (next: ApprovalMode) => Promise<void>;
}

export function useComposerSettings(agentId: string, workerId: string | undefined, model: string): ComposerSettings {
  const { agentCommands } = useRendererRuntime();
  const inferenceConfig = useInferenceStore((store) => store.config);
  const aiModels = useInferenceStore((store) => store.models.ai);
  const availableAiTargets = useInferenceStore((store) => store.availableTargets.ai);
  const updateModelReasoningDefault = useInferenceStore((store) => store.updateModelReasoningDefault);
  const modelGroups = useMemo(
    () => getAvailableModelOptions(inferenceConfig, aiModels, availableAiTargets, 'ai'),
    [aiModels, availableAiTargets, inferenceConfig],
  );

  const onModelChange = useCallback(
    async (next: string) => {
      if (workerId) await agentCommands.setSubagentModel(agentId, workerId, next);
      else await agentCommands.setModel(agentId, next);
    },
    [agentCommands, agentId, workerId],
  );

  const onReasoningChange = useCallback(
    async (selection?: ReasoningSelection) => {
      if (!model || !selection) return;
      const updated = await updateModelReasoningDefault(model, selection);
      if (!updated) return;
      // 清掉 agent 级 override，回落到刚更新的模型默认值
      if (workerId) await agentCommands.setSubagentReasoning(agentId, workerId, undefined);
      else await agentCommands.setReasoning(agentId, undefined);
    },
    [agentCommands, agentId, model, updateModelReasoningDefault, workerId],
  );

  const onModeChange = useCallback(
    async (next: AgentModeId) => {
      if (workerId) return;
      await agentCommands.setMode(agentId, next);
    },
    [agentCommands, agentId, workerId],
  );

  const onApprovalModeChange = useCallback(
    async (next: ApprovalMode) => {
      if (workerId) await agentCommands.setSubagentApprovalMode(agentId, workerId, next);
      else await agentCommands.setApprovalMode(agentId, next);
    },
    [agentCommands, agentId, workerId],
  );

  return useMemo(
    () => ({
      modelGroups,
      onModelChange,
      onReasoningChange,
      onModeChange,
      onApprovalModeChange,
    }),
    [modelGroups, onApprovalModeChange, onModeChange, onModelChange, onReasoningChange],
  );
}
