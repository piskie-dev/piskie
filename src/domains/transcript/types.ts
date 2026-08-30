import type { ConversationEntry } from '@shared/types/agent-control';
import type { TranscriptNode } from './nodes';

export type { TranscriptNode };

export interface TranscriptProjection {
  readonly range: { readonly from: number; readonly toExclusive: number };
  readonly nodes: readonly TranscriptNode[];
  readonly nodeIdsByEntry: ReadonlyMap<number, readonly string[]>;
  readonly toolNodeByCallId: ReadonlyMap<string, string>;
}

export interface LivePart {
  readonly kind: 'think' | 'text';
  readonly markdown: string;
}

export type LiveSuppressionReason =
  | 'missing-prefix'
  | 'sequence-gap'
  | 'run-conflict'
  | 'memory-limit';

export type LiveGeneration =
  | { readonly phase: 'none' }
  | {
      readonly phase: 'streaming';
      readonly requestId: string;
      readonly runId: string;
      readonly attempt: number;
      readonly lastSequence: number;
      readonly parts: readonly LivePart[];
    }
  | {
      readonly phase: 'awaiting-commit';
      readonly requestId: string;
      readonly runId: string;
      readonly attempt: number;
      readonly parts: readonly LivePart[];
    }
  | {
      readonly phase: 'suppressed';
      readonly requestId: string;
      readonly runId?: string;
      readonly reason: LiveSuppressionReason;
    }
  | { readonly phase: 'closed'; readonly requestId: string; readonly runId?: string };

export type TranscriptSessionSnapshot =
  | {
      readonly phase: 'idle' | 'loading';
      readonly projection: TranscriptProjection;
      readonly live: LiveGeneration;
      readonly total: number;
      readonly hasEarlier: boolean;
      readonly error: null;
    }
  | {
      readonly phase: 'ready';
      readonly projection: TranscriptProjection;
      readonly live: LiveGeneration;
      readonly total: number;
      readonly hasEarlier: boolean;
      readonly error: null;
    }
  | {
      readonly phase: 'failed';
      readonly projection: TranscriptProjection;
      readonly live: LiveGeneration;
      readonly total: number;
      readonly hasEarlier: boolean;
      readonly error: string;
    };

export interface IndexedConversationEntry {
  readonly index: number;
  readonly entry: ConversationEntry;
}
