import type {
  ConversationEntry,
  ToolEntry,
} from '@shared/types/agent-control';
import {
  projectEntryNodes,
  type IndexedToolResult,
} from './project-entry';
import type { NoticeNode } from './nodes';
import type { TranscriptNode, TranscriptProjection } from './types';
import { messageText, rawText } from '@/features/console/data/presentationText';

const EMPTY_PROJECTION: TranscriptProjection = Object.freeze({
  range: Object.freeze({ from: 0, toExclusive: 0 }),
  nodes: Object.freeze([]),
  nodeIdsByEntry: new Map(),
  toolNodeByCallId: new Map(),
});

export class TranscriptProjector {
  private readonly entries = new Map<number, ConversationEntry>();
  private readonly visibleIndices = new Set<number>();
  private readonly nodesByEntry = new Map<number, readonly TranscriptNode[]>();
  private readonly toolResults = new Map<string, IndexedToolResult>();
  private readonly toolResultSource = new Map<string, number>();
  private readonly callSource = new Map<string, number>();
  private pendingCallId: string | undefined;
  private range = { from: 0, toExclusive: 0 };

  reset(
    from: number,
    entries: readonly ConversationEntry[],
    warmup: readonly { readonly index: number; readonly entry: ConversationEntry }[] = [],
  ): void {
    this.entries.clear();
    this.visibleIndices.clear();
    this.nodesByEntry.clear();
    this.toolResults.clear();
    this.toolResultSource.clear();
    this.callSource.clear();
    this.range = { from, toExclusive: from + entries.length };

    for (const item of warmup) this.ingest(item.index, item.entry, false);
    entries.forEach((entry, offset) => this.ingest(from + offset, entry, true));
  }

  apply(index: number, entry: ConversationEntry): boolean {
    if (this.entries.has(index)) return false;
    if (index !== this.range.toExclusive) return false;
    this.range = {
      from: this.range.from,
      toExclusive: index + 1,
    };
    this.ingest(index, entry, true);
    return true;
  }

  setPendingCallId(callId: string | undefined): boolean {
    if (callId === this.pendingCallId) return false;
    const affected = new Set<number>();
    if (this.pendingCallId) {
      const source = this.callSource.get(this.pendingCallId);
      if (source !== undefined) affected.add(source);
    }
    if (callId) {
      const source = this.callSource.get(callId);
      if (source !== undefined) affected.add(source);
    }
    this.pendingCallId = callId;
    for (const source of affected) this.reproject(source);
    return affected.size > 0;
  }

  snapshot(): TranscriptProjection {
    if (this.visibleIndices.size === 0 && this.range.toExclusive === 0) return EMPTY_PROJECTION;
    const ordered = [...this.visibleIndices].sort((left, right) => left - right);
    const nodes = ordered.flatMap((index) => this.nodesByEntry.get(index) ?? []);
    const nodeIdsByEntry = new Map<number, readonly string[]>();
    const toolNodeByCallId = new Map<string, string>();
    for (const index of ordered) {
      const entryNodes = this.nodesByEntry.get(index) ?? [];
      nodeIdsByEntry.set(index, entryNodes.map((node) => node.id));
      for (const node of entryNodes) {
        if (node.kind === 'tool' || node.kind === 'plan' || node.kind === 'worker') {
          toolNodeByCallId.set(node.id, node.id);
        }
      }
    }
    return {
      range: this.range,
      nodes,
      nodeIdsByEntry,
      toolNodeByCallId,
    };
  }

  visibleEntries(): readonly { readonly index: number; readonly entry: ConversationEntry }[] {
    return [...this.visibleIndices]
      .sort((left, right) => left - right)
      .map((index) => ({ index, entry: this.entries.get(index)! }));
  }

  private ingest(index: number, entry: ConversationEntry, visible: boolean): void {
    this.entries.set(index, entry);
    if (visible) this.visibleIndices.add(index);

    if (entry.t === 'tool') {
      this.toolResults.set(entry.toolUseId, { entry, index });
      this.toolResultSource.set(entry.toolUseId, index);
      if (visible) this.nodesByEntry.set(index, this.projectToolResult(index, entry));
      const source = this.callSource.get(entry.toolUseId);
      if (source !== undefined && this.visibleIndices.has(source)) {
        this.nodesByEntry.set(index, []);
        this.reproject(source);
      }
      return;
    }

    for (const callId of toolCalls(entry)) {
      this.callSource.set(callId, index);
      const resultSource = this.toolResultSource.get(callId);
      if (resultSource !== undefined && resultSource !== index && this.visibleIndices.has(resultSource)) {
        this.nodesByEntry.set(resultSource, []);
      }
    }
    if (visible) this.reproject(index);
  }

  private reproject(index: number): void {
    const entry = this.entries.get(index);
    if (!entry || !this.visibleIndices.has(index)) return;
    this.nodesByEntry.set(index, projectEntryNodes(entry, index, this.toolResults, {
      pendingCallId: this.pendingCallId,
    }));
  }

  private projectToolResult(index: number, entry: ToolEntry) {
    const source = this.callSource.get(entry.toolUseId);
    const call = source === undefined ? undefined : this.entries.get(source);
    if (call?.t === 'msg' && source !== undefined && !this.visibleIndices.has(source)) {
      return projectEntryNodes(call, index, this.toolResults, {
        pendingCallId: this.pendingCallId,
      });
    }
    if (source !== undefined) return [];
    return [genericToolResult(index, entry)];
  }
}

function toolCalls(entry: ConversationEntry): readonly string[] {
  if (entry.t !== 'msg' || entry.role !== 'assistant' || !Array.isArray(entry.content)) return [];
  return entry.content.flatMap((block) => (
    block.type === 'tool_use' && block.id ? [block.id] : []
  ));
}

function genericToolResult(index: number, entry: ToolEntry): NoticeNode {
  const text = entry.result
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
  const summary = text.trim()
    ? rawText(text.trim().slice(0, 120))
    : messageText('transcript.summary.call', { callId: rawText(entry.toolUseId) });
  return {
    kind: 'notice',
    id: `tool-result:${entry.toolUseId}:${index}`,
    ts: entry.ts,
    sourceIndex: index,
    titleKey: 'transcript.title.toolResult',
    summary,
    meta: [messageText('transcript.meta.call', { callId: rawText(entry.toolUseId) })],
    source: entry.toolUseId,
    text,
    tone: entry.ok === false ? 'danger' : 'muted',
    interaction: text.length > 120 ? 'expand' : 'none',
    defaultExpanded: false,
    summaryDuplicatesDetail: false,
    detail: text.length > 120
      ? () => ({ sections: [{ value: text, format: 'text' }] })
      : undefined,
  };
}
