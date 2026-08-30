import type { ToolArtifact } from '../../../shared/types/index.js';
import type { TerminalReason, ToolResult } from '../../tools/types.js';
import type {
  SettlementResult,
  Settler,
} from '../conversation/settler.js';

/** A completed call whose result has not yet crossed the conversation boundary. */
export class PendingSettlement {
  #terminal?: TerminalReason;

  constructor(
    readonly callId: string,
    readonly toolName: string,
    readonly result: ToolResult,
    terminal?: TerminalReason,
    readonly artifacts?: ToolArtifact[],
  ) {
    this.#terminal = terminal;
  }

  /** The only path that can release a staged terminal effect. */
  commit(settler: Settler): {
    settled: SettlementResult;
    terminal?: TerminalReason;
  } {
    const settled = settler.settleLive({
      kind: 'tool',
      callId: this.callId,
      toolName: this.toolName,
      result: this.result,
      artifacts: this.artifacts,
    });
    return settled === 'inserted' && this.result.ok
      ? { settled, terminal: this.#terminal }
      : { settled };
  }
}
