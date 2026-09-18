import type { AgentModeId, AgentRunConfig, ApprovalMode } from '../../../shared/types/index.js';
import type { AgentControlState } from '../../../shared/types/agent-control.js';
import { directorSpec } from '../specs/builtin/director.js';

export interface DirectorLaunchOptions {
  modeId: AgentModeId;
  approvalMode: ApprovalMode;
  /** 不给则用当前默认模型。 */
  model?: string;
}

/**
 * 起一个顶层 Director 运行。`agent_run` 工具与定时任务共用这一入口，
 * 保证两边对 spec、模式与模型的选择一致。
 */
export async function startDirectorRun(
  runConfig: AgentRunConfig,
  options: DirectorLaunchOptions,
): Promise<AgentControlState> {
  const { agentService } = await import('../../services/agent.service.js');
  return agentService.startAgent({
    runConfig,
    agentSpec: directorSpec,
    initialModeId: options.modeId,
    initialApprovalMode: options.approvalMode,
    launchOptions: { initialModel: options.model },
  });
}
