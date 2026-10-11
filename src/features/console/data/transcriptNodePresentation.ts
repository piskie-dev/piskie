import type { TFunction } from 'i18next';
import type { ThinkNode, TranscriptNode } from '@/domains/transcript/nodes';
import { resolvePresentationText } from './presentationText';

/** Content rendered by ThreadCell, including attachment-only input and live reasoning. */
export function hasVisibleTranscriptContent(node: TranscriptNode): boolean {
  if (node.kind === 'assistant') return node.markdown.trim().length > 0;
  if (node.kind === 'user' && node.origin === 'user') {
    return !!(node.text || node.skills?.length || node.skillLoadErrors?.length || node.browserEnvironmentIds?.length
      || node.files?.length || node.images?.length);
  }
  return true;
}

export function transcriptNodeTitle(node: TranscriptNode, t: TFunction): string {
  if (node.kind === 'plan') return t('transcript.title.executionPlan');
  if (node.kind === 'notice' && node.eventType) return t('transcript.notice.workerMessage');
  if (node.kind === 'think' && node.live) return t('transcript.thinking');
  return t(node.titleKey, node.titleArgs ?? {});
}

export function transcriptNodeSummary(node: TranscriptNode, t: TFunction): string | undefined {
  if (node.kind === 'tool' && node.fileOp?.kind === 'read'
    && node.fileOp.startLine !== undefined && node.fileOp.endLine !== undefined) return node.fileOp.path;
  return node.summary && resolvePresentationText(node.summary, (key, values) => t(key, values ?? {}));
}

/** The reasoning disclosure follows the latest live line and the first persisted line. */
export function transcriptThinkPreview(node: ThinkNode): string {
  const text = node.live ? node.markdown.trimEnd() : node.markdown;
  const newline = node.live ? text.lastIndexOf('\n') : text.indexOf('\n');
  return newline === -1 ? text : node.live ? text.slice(newline + 1) : text.slice(0, newline);
}

/** One-line presentation of the same content and headings used by the transcript. */
export function transcriptNodeText(node: TranscriptNode, t: TFunction): string {
  const title = transcriptNodeTitle(node, t);
  const summary = transcriptNodeSummary(node, t);
  let text: string | undefined;
  switch (node.kind) {
    case 'tool': return summary ? `${title} · ${summary}` : title;
    case 'assistant': return node.markdown.replace(/\s+/g, ' ').trim();
    case 'think': text = transcriptThinkPreview(node); break;
    case 'user':
      if (node.origin === 'user') return (node.text || summary || '').replace(/\s+/g, ' ').trim();
      text = node.origin === 'assignment' ? node.text || summary : summary;
      break;
    case 'worker': text = node.subject; break;
    case 'plan': text = node.taskSummary; break;
    case 'summary': return title;
    default: text = summary;
  }
  const line = text?.replace(/\s+/g, ' ').trim();
  return line ? `${title} · ${line}` : title;
}
