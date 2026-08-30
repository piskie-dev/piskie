import type {
  AgentLaunchOptions,
  AgentModeId,
  AgentRunConfig,
  ApprovalMode,
} from '../../../shared/types/index.js';
import type { AgentSpec } from '../specs/spec.js';

export interface ResolvedAgentLaunch {
  runConfig: AgentRunConfig;
  agentSpec: AgentSpec;
  initialModeId: AgentModeId;
  initialApprovalMode: ApprovalMode;
  launchOptions?: AgentLaunchOptions;
}
