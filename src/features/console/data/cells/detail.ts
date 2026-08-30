/**
 * 详情区块与交互形态。
 *
 * 两条约束：
 * 1. **求值时机**：sections 只在详情组件展开时由 thunk materialize，折叠即释放。
 * 2. **范围**：只为「走通用条目路径」的 kind 生成 sections（assistant / user / notice / tool / summary）。
 *    plan / worker 由专用组件接管，不生成。
 *
 * `hasMeaningfulDetails` 里若干分支存在先后依赖（如"待确认恒为 true"早于截图判断、
 * "执行中看参数长度"早于 sections 判断），改动判据顺序会改变结果。
 */

import {
  hasSerializableContent,
  isJsonLikeString,
  readableToolResultText,
  serializableLength,
} from './toolSummary';
import type { QuestionAnswerItem, ToolCellArtifact } from '../toolArtifacts';
import type {
  TranscriptInteraction,
  TranscriptNodeKind,
  DetailFormat,
  DetailSection,
  ToolState,
} from '@/domains/transcript/nodes';

// ==================== section 装配原语 ====================

type PendingSection = {
  value: unknown;
  format: DetailFormat;
};

function pushSection(out: DetailSection[], section: PendingSection): void {
  if (!hasSerializableContent(section.value)) return;
  out.push(section);
}

function debugFormat(value: unknown): DetailFormat {
  if (typeof value === 'string') return isJsonLikeString(value) ? 'json' : 'code';
  return 'json';
}

// ==================== 工具 cell 的 sections ====================

export interface ToolDetailInput {
  readonly tool: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly state: ToolState;
  /**
   * `tool-detail` slot 的问答投影：存在时先显示可读问答，canonical result 仍保留供诊断。
   */
  readonly questionAnswers?: readonly QuestionAnswerItem[];
  /** `tool-detail` slot 的 MCP 音频投影。 */
  readonly mcpAudio?: readonly Extract<ToolCellArtifact, { kind: 'mcp_audio' }>[];
}

interface ToolFactsOptions {
  skipRawResult?: boolean;
}

function pushToolFacts(
  out: DetailSection[],
  input: ToolDetailInput,
  options: ToolFactsOptions = {},
): void {
  if (input.params !== undefined) {
    pushSection(out, { value: input.params, format: 'json' });
  }

  if (input.result !== undefined && !options.skipRawResult) {
    pushSection(out, { value: input.result, format: debugFormat(input.result) });
  }
}

/** 原始返回就是那段可读文本本身时不重复展示 */
function rawResultIsReadable(result: unknown, readable: string | undefined): boolean {
  if (typeof result !== 'string' || readable === undefined) return false;
  const trimmed = result.trim();
  const safe = !trimmed || isJsonLikeString(trimmed) ? undefined : trimmed;
  return safe === readable;
}

export function toolSections(input: ToolDetailInput): DetailSection[] {
  const out: DetailSection[] = [];
  const { state } = input;

  if (state.phase === 'running' || state.phase === 'awaiting-approval') {
    pushToolFacts(out, input, { skipRawResult: true });
    return out;
  }

  if (state.phase === 'cancelled') {
    if (state.reason) {
      pushSection(out, { value: state.reason, format: 'text' });
    }
    pushToolFacts(out, input, { skipRawResult: true });
    return out;
  }

  if (state.phase === 'failed') {
    if (typeof input.result === 'string') {
      pushSection(out, { value: state.error || input.result, format: 'text' });
      pushToolFacts(out, input, { skipRawResult: true });
      return out;
    }
    if (input.result === undefined && state.error) {
      pushSection(out, { value: state.error, format: 'text' });
    }
    pushToolFacts(out, input);
    return out;
  }

  // phase === 'ok'
  const readable = readableToolResultText(input.result);

  if (input.questionAnswers && input.questionAnswers.length > 0) {
    // 结构化问答先显示；canonical result 仍作为独立诊断事实。
    pushSection(out, {
      value: input.questionAnswers,
      format: 'question_answers',
    });
    pushToolFacts(out, input);
    return out;
  }

  if (input.mcpAudio && input.mcpAudio.length > 0) {
    pushSection(out, {
      value: input.mcpAudio,
      format: 'audio_blocks',
    });
  }

  if (readable) {
    pushSection(out, { value: readable, format: 'text' });
  }

  pushToolFacts(out, input, {
    skipRawResult: rawResultIsReadable(input.result, readable),
  });

  return out;
}

// ==================== 其余 kind 的 sections ====================

export function assistantSections(markdown: string): DetailSection[] {
  const out: DetailSection[] = [];
  pushSection(out, { value: markdown, format: 'markdown' });
  return out;
}

export function userSections(
  text?: string,
  /** 任务分派的原始 `<task_board>` 片段；人读形态在右栏任务看板。 */
  taskBoard?: string,
): DetailSection[] {
  const out: DetailSection[] = [];
  if (text) {
    pushSection(out, { value: text, format: 'text' });
  }
  if (taskBoard) {
    pushSection(out, { value: taskBoard, format: 'text' });
  }
  return out;
}

export function noticeSections(
  content: unknown,
  options: {
    readonly guidance?: unknown;
    readonly details?: Readonly<Record<string, unknown>>;
  } = {},
): DetailSection[] {
  const out: DetailSection[] = [];
  if (content !== undefined) {
    pushSection(out, { value: content, format: 'text' });
  }
  if (options.details && Object.keys(options.details).length > 0) {
    pushSection(out, { value: options.details, format: 'json' });
  }
  if (options.guidance) {
    pushSection(out, { value: options.guidance, format: 'text' });
  }
  return out;
}

export function summarySections(markdown: string): DetailSection[] {
  const out: DetailSection[] = [];
  pushSection(out, { value: markdown, format: 'markdown' });
  return out;
}

// ==================== 交互形态 ====================

export interface InteractionInput {
  readonly kind: TranscriptNodeKind;
  readonly sections: readonly DetailSection[];
  /** 策略强制值（移动端动作工具终态） */
  readonly forceInteraction?: TranscriptInteraction;
  readonly tool?: ToolDetailInput;
  readonly assistantText?: string;
  readonly noticeContent?: unknown;
  /** Projection can declare detail availability without materializing its sections. */
  readonly hasDetail?: boolean;
}

/**
 * 是否有值得展开的内容。**分支顺序有语义**：靠前的分支一旦命中就不再看后面的判据。
 */
export function hasMeaningfulDetails(input: InteractionInput): boolean {
  const { kind, tool, sections } = input;

  if (tool?.state.phase === 'awaiting-approval') return true;
  if (tool?.state.phase === 'running') return serializableLength(tool.params) > 140;

  if (input.hasDetail || sections.length > 0) return true;

  if (kind === 'assistant') return !!input.assistantText?.trim();
  if (kind === 'notice') return serializableLength(input.noticeContent) > 140;
  if (kind === 'summary') return true;

  if (tool) {
    if (tool.state.phase === 'ok') {
      return (
        serializableLength(tool.result) > 220 ||
        serializableLength(tool.params) > 140
      );
    }
    if (tool.state.phase === 'failed') {
      return tool.state.error.length > 120 || tool.result !== undefined;
    }
    if (tool.state.phase === 'cancelled') {
      return tool.state.reason !== undefined;
    }
  }

  return false;
}

/** 交互形态。与上面同理，判据顺序有语义 */
export function resolveInteraction(input: InteractionInput): TranscriptInteraction {
  const { tool, kind } = input;

  if (tool?.state.phase === 'awaiting-approval') return 'preview';
  if (input.forceInteraction) return input.forceInteraction;

  const meaningful = hasMeaningfulDetails(input);
  if (kind === 'assistant' && meaningful) return 'expand';
  if (!meaningful) return 'none';

  if (tool?.state.phase === 'ok' && serializableLength(tool.result) > 320) return 'modal';
  if (kind === 'notice' && serializableLength(input.noticeContent) > 320) return 'modal';
  if (tool?.state.phase === 'failed' && tool.state.error.length > 280) return 'modal';

  return 'expand';
}
