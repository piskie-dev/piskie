import { appLog } from '@electron/observability/logging/app-log.js';
import type { ConversationWriteEntry } from '../../../shared/types/agent-control.js';
import type { ToolArtifact, ToolResultContentBlock } from '../../../shared/types/index.js';
import type { ImageRef, ToolResult } from '../../tools/types.js';
import type { AgentConversationContext } from '../context/agent-conversation-context.js';
import { resolveToolUseSettlement } from '../context/conversation-protocol.js';
import {
  renderAnswer,
  renderNotification,
  renderReminder,
  renderToolResult,
  type BackgroundDoneEvent,
} from './model-text.js';

export type SettlementResult = 'inserted' | 'already_settled' | 'unresolvable';

export type LiveSettlement =
  | {
      kind: 'tool';
      callId: string;
      toolName: string;
      result: ToolResult;
      artifacts?: ToolArtifact[];
    }
  | {
      kind: 'answer';
      callId: string;
      toolName: string;
      text: string;
      images?: ImageRef[];
      artifacts?: ToolArtifact[];
    }
  | {
      kind: 'system';
      callId: string;
      toolName: string;
      text: string;
      ok: boolean;
    };

export interface SettlementConversation {
  resolve(callId: string): 'insertable' | 'already_settled' | 'unresolvable';
  appendLiveToolResult(
    callId: string,
    blocks: ToolResultContentBlock[],
    ok: boolean,
    artifacts?: ToolArtifact[]
  ): void;
  appendRecoveryToolResult(callId: string, blocks: ToolResultContentBlock[], ok: boolean): void;
  appendSystemMessage(blocks: ToolResultContentBlock[]): void;
}

/** Production adapter: live results are persisted before entering the in-memory projection. */
export class ContextSettlementConversation implements SettlementConversation {
  constructor(
    private readonly context: AgentConversationContext,
    private readonly appendEntry: (entry: ConversationWriteEntry) => void
  ) {}

  resolve(callId: string): 'insertable' | 'already_settled' | 'unresolvable' {
    return resolveToolUseSettlement(this.context.getAllMessages(), callId);
  }

  appendLiveToolResult(
    callId: string,
    blocks: ToolResultContentBlock[],
    ok: boolean,
    artifacts?: ToolArtifact[]
  ): void {
    const result = this.context.prepareToolResultBlocks(blocks);
    const timestamp = Date.now();
    // 同一 append、两种投影：完整 UI 记录（含 artifacts）写盘，
    // context 只投影模型结果——不是先塞进 context 再删除。
    this.appendEntry({
      t: 'tool',
      ts: timestamp,
      toolUseId: callId,
      result,
      ok,
      ...(artifacts?.length ? { artifacts } : {}),
    });
    this.context.appendToolResultProjection(callId, result, ok, timestamp);
  }

  appendRecoveryToolResult(callId: string, blocks: ToolResultContentBlock[], ok: boolean): void {
    this.context.appendToolResultProjection(callId, blocks, ok, Date.now());
  }

  appendSystemMessage(blocks: ToolResultContentBlock[]): void {
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    this.context.addUserMessage(text, 'system_event');
  }
}

function asRuntimeBlocks(content: string | ToolResultContentBlock[]): ToolResultContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((block): ToolResultContentBlock => {
    if (block.type === 'text') return { type: 'text', text: block.text ?? '' };
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: block.source?.media_type ?? 'application/octet-stream',
        data: block.source?.data ?? '',
      },
    };
  });
}

export class Settler {
  constructor(
    private readonly conversation: SettlementConversation,
    private readonly onLiveSettled: (callId: string) => void
  ) {}

  settleLive(settlement: LiveSettlement): SettlementResult {
    const resolution = this.conversation.resolve(settlement.callId);
    if (resolution !== 'insertable') {
      appLog.warn({
        event: 'agent.tool_settlement.commit.skipped',
        message: 'Live tool settlement skipped',
        context: {
          scope: 'agent.tool_settlement',
          callId: settlement.callId,
          toolName: settlement.toolName,
          settlementKind: settlement.kind,
          reason: resolution,
        },
      });
      return resolution;
    }
    if (settlement.kind === 'tool') {
      const rendered = renderToolResult(settlement.result, settlement.toolName);
      this.conversation.appendLiveToolResult(
        settlement.callId,
        asRuntimeBlocks(rendered.content),
        settlement.result.ok,
        settlement.artifacts
      );
    } else if (settlement.kind === 'answer') {
      this.conversation.appendLiveToolResult(
        settlement.callId,
        asRuntimeBlocks(renderAnswer(settlement.text, settlement.images)),
        true,
        settlement.artifacts
      );
    } else {
      const rendered = renderToolResult(
        { ok: settlement.ok, text: settlement.text },
        settlement.toolName
      );
      this.conversation.appendLiveToolResult(
        settlement.callId,
        asRuntimeBlocks(rendered.content),
        settlement.ok
      );
    }
    this.onLiveSettled(settlement.callId);
    return 'inserted';
  }

  settleRecovery(input: {
    conversationId: string;
    callId: string;
    blocks: ToolResultContentBlock[];
    ok: boolean;
  }): SettlementResult {
    void input.conversationId;
    const resolution = this.conversation.resolve(input.callId);
    if (resolution !== 'insertable') return resolution;
    this.conversation.appendRecoveryToolResult(input.callId, input.blocks, input.ok);
    return 'inserted';
  }

  notify(event: BackgroundDoneEvent): void {
    this.conversation.appendSystemMessage([{ type: 'text', text: renderNotification(event) }]);
  }

  remind(text: string): void {
    this.conversation.appendSystemMessage([{ type: 'text', text: renderReminder(text) }]);
  }
}
