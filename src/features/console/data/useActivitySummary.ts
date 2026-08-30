/** Locale-neutral projection of what an agent is doing now. */

import type { AgentPhase, TaskItem } from '../../../../shared/types';
import type { TranscriptNode } from '@/domains/transcript/nodes';
import { resolveToolTitle } from './cells/toolTitle';
import {
  messageText,
  rawText,
  type PresentationText,
} from './presentationText';

export type ActivityKind =
  | 'awaiting-answer'
  | 'awaiting-approval'
  | 'stopping'
  | 'interrupted'
  | 'tasks'
  | 'action'
  | 'thinking'
  | 'idle';

export interface ActivitySummary {
  readonly kind: ActivityKind;
  readonly text: PresentationText;
}

export interface ActivityInput {
  readonly phase: AgentPhase;
  readonly interrupted?: boolean;
  readonly askUser?: { readonly items: readonly { question: string }[] };
  readonly pendingToolName?: string;
  readonly taskBoard?: { readonly items: readonly TaskItem[] };
  readonly nodes?: readonly TranscriptNode[];
  readonly fallback?: PresentationText;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncateInline(text: string | undefined, max = 84): string | undefined {
  if (!text) return undefined;
  const normalized = normalize(text);
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function truncatedRaw(text: string | undefined, max = 84): PresentationText | undefined {
  const value = truncateInline(text, max);
  return value ? rawText(value) : undefined;
}

function truncatePresentationText(
  value: PresentationText | undefined,
  max = 84,
): PresentationText | undefined {
  if (!value || value.kind === 'message') return value;
  return truncatedRaw(value.text, max);
}

function titleText(node: Pick<TranscriptNode, 'titleKey' | 'titleArgs'>): PresentationText {
  return messageText(node.titleKey, node.titleArgs);
}

function latestAction(nodes: readonly TranscriptNode[] | undefined): PresentationText | undefined {
  if (!nodes) return undefined;

  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!;
    if (node.kind === 'user') continue;

    if (node.kind === 'tool') {
      const action = titleText(node);
      const summary = truncatePresentationText(node.summary);
      return summary
        ? messageText('transcript.activity.actionWithSummary', { action, summary })
        : action;
    }

    if (node.kind === 'assistant') return truncatedRaw(node.markdown);
    if (node.kind === 'think') return truncatedRaw(node.markdown);
    if (node.kind === 'plan') {
      return truncatedRaw(node.taskSummary) ?? messageText('transcript.activity.submitPlan');
    }
    if (node.kind === 'worker') {
      return truncatedRaw(node.subject) ?? messageText('transcript.activity.createWorker');
    }
    if (node.kind === 'summary') return truncatedRaw(node.preview);
    if (node.kind === 'notice') return truncatedRaw(node.text);
  }

  return undefined;
}

function taskProgress(items: readonly TaskItem[]): PresentationText {
  const completed = items.filter((item) => item.status === 'completed').length;
  const current =
    items.find((item) => item.status === 'in_progress')
    ?? items.find((item) => item.status === 'pending');
  const subject = truncatedRaw(current?.subject);

  return subject
    ? messageText('transcript.activity.taskProgressWithSubject', {
        completed,
        total: items.length,
        subject,
      })
    : messageText('transcript.activity.taskProgress', { completed, total: items.length });
}

function pendingToolTitle(tool: string): PresentationText {
  const title = resolveToolTitle({ tool });
  return messageText(title.titleKey, title.titleArgs);
}

/** Pure priority ladder shared by every Console presenter. */
export function resolveActivitySummary(input: ActivityInput): ActivitySummary {
  const askUserItems = input.askUser?.items;
  if (askUserItems?.length) {
    const question = truncatedRaw(askUserItems[0]?.question, 92);
    const text = question
      ? askUserItems.length > 1
        ? messageText('transcript.activity.questionCount', {
            question,
            count: askUserItems.length,
          })
        : question
      : messageText('transcript.activity.awaitingAnswer');
    return { kind: 'awaiting-answer', text };
  }

  if (input.pendingToolName) {
    return { kind: 'awaiting-approval', text: pendingToolTitle(input.pendingToolName) };
  }

  if (input.phase === 'stopping') {
    return { kind: 'stopping', text: messageText('transcript.activity.stopping') };
  }

  if (input.interrupted) {
    return { kind: 'interrupted', text: messageText('transcript.activity.interrupted') };
  }

  if (input.taskBoard && input.taskBoard.items.length > 0) {
    return { kind: 'tasks', text: taskProgress(input.taskBoard.items) };
  }

  const action = latestAction(input.nodes);
  if (action) return { kind: 'action', text: action };

  if (input.phase === 'thinking') {
    return { kind: 'thinking', text: messageText('transcript.activity.thinking') };
  }

  return {
    kind: 'idle',
    text: input.fallback ?? messageText('transcript.activity.idle'),
  };
}
