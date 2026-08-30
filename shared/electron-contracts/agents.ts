import type {
  AgentLaunchOptions,
  AgentModeId,
  ApprovalMode,
  ConversationAppendEvent,
  ConversationEntry,
  AgentInputEvent,
  ToolApprovalDecision,
} from '../types/index.js';
import type { ReasoningSelection } from '../types/reasoning.js';
import type { ContextSnapshot } from '../types/token.js';
import type {
  AgentControlChangedEvent,
  AgentControlSnapshot,
} from './agent-runs.js';

export const AGENT_OPERATIONS = Object.freeze({
  start: 'agents.start',
  setMode: 'agents.setMode',
  listStates: 'agents.listStates',
  stop: 'agents.stop',
  resume: 'agents.resume',
  inject: 'agents.inject',
  injectSubagent: 'agents.injectSubagent',
  setModel: 'agents.setModel',
  setSubagentModel: 'agents.setSubagentModel',
  setReasoning: 'agents.setReasoning',
  setSubagentReasoning: 'agents.setSubagentReasoning',
  interrupt: 'agents.interrupt',
  interruptSubagent: 'agents.interruptSubagent',
  conversation: 'agents.conversation',
  context: 'agents.context',
  setApprovalMode: 'agents.approval.setMode',
  setSubagentApprovalMode: 'agents.approval.setSubagentMode',
  respondToApproval: 'agents.approval.respond',
  approveImages: 'agents.images.approve',
  enterImageEdit: 'agents.images.enterEdit',
  regenerateImages: 'agents.images.regenerate',
  cancelImages: 'agents.images.cancel',
  deleteImage: 'agents.images.delete',
  changeImageModel: 'agents.images.changeModel',
  promoteToolToBackground: 'agents.tools.promoteToBackground',
} as const);

export const AGENT_TOPICS = Object.freeze({
  state: 'agents.state',
  conversation: 'agents.conversation',
  liveContent: 'agents.live-content',
} as const);

export interface AgentLiveContentDelta {
  agentId: string;
  requestId: string;
  runId: string;
  attempt: number;
  sequence: number;
  kind: 'think' | 'text';
  delta: string;
}

export type ConversationPageRequest =
  | { readonly direction: 'tail'; readonly limit: number }
  | { readonly direction: 'forward'; readonly from: number; readonly limit: number }
  | { readonly direction: 'backward'; readonly before: number; readonly limit: number };

export interface ConversationPage {
  readonly from: number;
  readonly entries: readonly ConversationEntry[];
  readonly total: number;
}

interface AgentImageRegenerateInput {
  agentId: string;
  nodeId: string;
  imageIds: string[];
  instruction: string;
  target?: { providerId: string; modelId: string };
  images?: Array<{ data: string; media_type: string }>;
}

interface AgentImagesClient {
  approve(agentId: string, nodeId: string): Promise<void>;
  enterEdit(agentId: string, nodeId: string): Promise<void>;
  regenerate(input: AgentImageRegenerateInput): Promise<void>;
  cancel(agentId: string, nodeId: string, reason?: string): Promise<void>;
  delete(agentId: string, nodeId: string, imageId: string): Promise<void>;
  changeModel(
    agentId: string,
    nodeId: string,
    target: { providerId: string; modelId: string },
  ): Promise<void>;
}

interface AgentApprovalClient {
  setMode(agentId: string, mode: ApprovalMode): Promise<void>;
  setSubagentMode(agentId: string, subagentId: string, mode: ApprovalMode): Promise<void>;
  respond(
    agentId: string,
    subagentId: string | undefined,
    decision: ToolApprovalDecision,
  ): Promise<void>;
}

interface AgentToolsClient {
  promoteToBackground(callId: string): Promise<boolean>;
}

interface StartAgentCommon {
  workspace?: string;
  approvalMode?: ApprovalMode;
  environmentIds?: string[];
  launchOptions?: AgentLaunchOptions;
}

export type StartAgentRequest = StartAgentCommon & (
  | {
      definitionId: string;
      input?: never;
      modeId?: 'normal' | 'plan';
    }
  | {
      input: string;
      definitionId?: never;
      modeId: 'normal' | 'plan' | 'browser-skill';
    }
);

export interface AgentClient {
  start(request: StartAgentRequest): Promise<AgentControlSnapshot>;
  setMode(agentId: string, modeId: AgentModeId): Promise<void>;
  listStates(): Promise<Record<string, AgentControlSnapshot>>;
  stop(agentId: string): Promise<void>;
  resume(agentId: string): Promise<AgentControlSnapshot | null>;
  inject(agentId: string, event: AgentInputEvent): Promise<void>;
  injectSubagent(agentId: string, subagentId: string, event: AgentInputEvent): Promise<void>;
  setModel(agentId: string, model: string): Promise<void>;
  setSubagentModel(agentId: string, subagentId: string, model: string): Promise<void>;
  setReasoning(agentId: string, selection: ReasoningSelection | null): Promise<void>;
  setSubagentReasoning(
    agentId: string,
    subagentId: string,
    selection: ReasoningSelection | null,
  ): Promise<void>;
  interrupt(agentId: string): Promise<void>;
  interruptSubagent(agentId: string, subagentId: string): Promise<void>;
  conversation(agentId: string, page: ConversationPageRequest): Promise<ConversationPage>;
  context(agentId: string): Promise<ContextSnapshot>;
  observeState(listener: (event: AgentControlChangedEvent) => void): () => void;
  observeConversation(listener: (event: ConversationAppendEvent) => void): () => void;
  observeLiveContent(listener: (event: AgentLiveContentDelta) => void): () => void;
  readonly approval: AgentApprovalClient;
  readonly images: AgentImagesClient;
  readonly tools: AgentToolsClient;
}
