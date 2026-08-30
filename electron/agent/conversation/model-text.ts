import type { ToolResultContentBlock } from '../../../shared/types/index.js';
import type { ImageRef, ToolResult } from '../../tools/types.js';

export type BackgroundDoneEvent = Readonly<{
  kind: 'background_task_done';
  taskId: string;
  outputFile: string;
  status: 'ok' | 'failed' | 'killed';
  summary: string;
  tail: string;
}>;

const PLATFORM_TAG = /<(\/?)(error|persisted-output|task-notification|system-reminder)(?=[\s>])/gi;

/** Neutralize only platform-owned tag boundaries; normal code and HTML stay intact. */
function neutralize(value: string): string {
  return value.replace(PLATFORM_TAG, (_match, slash: string, name: string) => `<${slash}\\${name}`);
}

function imageBlocks(images: readonly ImageRef[] | undefined): ToolResultContentBlock[] {
  return (images ?? []).map((image) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mediaType,
      data: image.base64,
    },
  }));
}

export function renderToolResult(
  result: ToolResult,
  toolName: string,
): { content: string | ToolResultContentBlock[]; isError: boolean } {
  const safeText = neutralize(result.text);
  let text = safeText;

  if (result.persisted) {
    const outputPath = neutralize(result.persisted.path);
    const preview = neutralize(result.persisted.preview);
    if (result.persisted.incomplete) {
      const reason = neutralize(result.persisted.incomplete.reason);
      text = [
        `<persisted-output>Output incomplete: received ${result.persisted.incomplete.observedBytes} bytes, saved only ${result.persisted.bytes} bytes to: ${outputPath}`,
        `Disk capture stopped: ${reason}. Middle output was lost.`,
        'Available inline head/tail:',
        safeText || preview,
        '</persisted-output>',
      ].join('\n');
    } else {
      text = [
        `<persisted-output>Output too large (${result.persisted.bytes} bytes). Full output saved to: ${outputPath}`,
        'Preview (first 2KB):',
        preview,
        '</persisted-output>',
      ].join('\n');
    }
  }

  if (!text && !result.images?.length) {
    text = `(${neutralize(toolName)} completed with no output)`;
  }
  if (!result.ok) text = `<error>${text}</error>`;

  const images = imageBlocks(result.images);
  return {
    content: images.length > 0
      ? [...(text ? [{ type: 'text' as const, text }] : []), ...images]
      : text,
    isError: !result.ok,
  };
}

export function renderAnswer(
  text: string,
  images?: readonly ImageRef[],
): ToolResultContentBlock[] {
  const safeText = neutralize(text);
  return [
    ...(safeText ? [{ type: 'text' as const, text: safeText }] : []),
    ...imageBlocks(images),
  ];
}

export function renderNotification(event: BackgroundDoneEvent): string {
  const taskId = neutralize(event.taskId);
  const outputFile = neutralize(event.outputFile);
  const summary = neutralize(event.summary);
  const tail = neutralize(event.tail);
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    `<output-file>${outputFile}</output-file>`,
    `<status>${event.status}</status>`,
    `<summary>${summary}</summary>`,
    `<tail>${tail}</tail>`,
    '</task-notification>',
  ].join('\n');
}

export function renderReminder(text: string): string {
  return `<system-reminder>${neutralize(text)}</system-reminder>`;
}
