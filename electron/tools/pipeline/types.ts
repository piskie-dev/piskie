import type { ToolApprovalDecision } from '../../../shared/types/index.js';
import type {
  PreparedCall,
  RawCall,
  Rejection,
  ToolResult,
} from '../types.js';

export type PrepareDraft = RawCall & {
  readonly entry: PreparedCall<unknown>['entry'];
  readonly ctx: PreparedCall<unknown>['ctx'];
  params?: unknown;
};

export interface ApprovalRequestPort {
  request(input: {
    call: PreparedCall<unknown>;
    description: string;
    preview?: Awaited<ReturnType<NonNullable<PreparedCall<unknown>['preview']>>>;
    modeInvariant: boolean;
  }): Promise<ToolApprovalDecision>;
}

export type PipelineRuntime = Readonly<{
  approval?: ApprovalRequestPort;
}>;

export type PrepareStep = (call: PrepareDraft) => void | Rejection;
export type AdmitStep = (
  call: PreparedCall<unknown>,
  runtime: PipelineRuntime,
) => Promise<void | Rejection>;
export type FinalizeStep = (
  call: PreparedCall<unknown>,
  result: ToolResult,
) => Promise<void>;
