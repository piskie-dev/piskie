/**
 * 文件操作的结构化载荷 —— 把 `read` / `write` / `edit` 三个工具的参数与返回值
 * 抽成可渲染的形状，供右栏「审阅」面板用（对应 threadApp 的 review 模块）。
 *
 * ## 为什么在前端重建，而不是拿后端的 unified diff
 *
 * 后端**确实算了**权威 diff：`edit.tool.ts` 的 `plan.diff.unifiedDiff`（带真实行号与
 * stat）。但它只出现在两个地方：
 * 1. `prepare()` 的预览 thunk ⇒ 只在 confirm 审批模式下经 `pendingToolCall.preview` 到前端；
 * 2. `execute()` 返回的 `ToolOutput.data` ⇒ 进 `ToolObservation`（观测/日志），
 *    **不进 `ConversationEntry`** —— 会话里的 tool 条目只有 `result` 文本块与 `ok`。
 *
 * 所以 auto 审批模式下前端拿不到那份 diff。要拿到就得改 `ToolEntry` 的形状 + 持久化 +
 * 压缩兼容，那是跨进程的会话记录格式改动，超出渲染层重写的范围。
 * 这里改为**从参数重建**，代价写在下面「已知不足」里，换取零后端改动。
 *
 * ## 已知不足（与 threadApp 的差距）
 *
 * | | 本实现 | 有后端 diff 时 |
 * |---|---|---|
 * | `write` 的行号 | **准确**（全量内容，1..N） | 同 |
 * | `edit` 的行号 | **没有**（不知道 old_string 落在文件第几行） | 准确 |
 * | 多次改同一文件 | 逐次 hunk 罗列 | 可合并成一份净 diff |
 * | 改动是否被后续覆盖 | 看不出来 | 能看出 |
 *
 * `edit` 的行号缺失是唯一肉眼可见的差距，故 `FileDiff.absoluteLines` 显式标注，
 * 视图据此决定画不画行号槽 —— 不画假行号。
 */

import type { FileOp } from '@/domains/transcript/nodes';
import { messageText, rawText } from '../presentationText';

export type { FileOp };

/** `read` 的行号前缀：6 位右对齐 + TAB（`electron/tools/fs/_lib/line-numbers.ts`） */
const READ_LINE_RE = /^\s*(\d+)\t([\s\S]*)$/;

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 从 read 的返回文本里剥出内容与起始行号。
 *
 * read 的返回是「行号 + TAB + 原行」逐行拼接，末尾可能追加若干条以空行分隔的提示
 * （已显示 x-y 行 / 并发修改警告…）。提示不带行号前缀，据此切断。
 */
function parseNumberedRead(text: string): { content: string; startLine?: number } {
  const lines = text.split('\n');
  const body: string[] = [];
  let startLine: number | undefined;

  for (const line of lines) {
    const match = READ_LINE_RE.exec(line);
    if (!match) {
      // 第一条不带行号的行即正文结束（后面都是提示）
      if (body.length > 0) break;
      continue;
    }
    if (startLine === undefined) startLine = Number(match[1]);
    body.push(match[2] ?? '');
  }

  return { content: body.join('\n'), startLine };
}

export function extractFileOp(input: {
  readonly tool: string;
  readonly params: unknown;
  readonly resultText?: string;
  readonly ok: boolean;
}): FileOp | undefined {
  if (!input.params || typeof input.params !== 'object') return undefined;
  const params = input.params as Record<string, unknown>;
  const path = str(params, 'file_path') ?? str(params, 'path');
  if (!path) return undefined;

  switch (input.tool) {
    case 'edit': {
      const oldText = str(params, 'old_string');
      const newText = str(params, 'new_string');
      // new_string 允许为空串（纯删除），所以用 undefined 判定而不是真值判定
      if (oldText === undefined || newText === undefined) return undefined;
      return {
        kind: 'edit',
        path,
        oldText,
        newText,
        replaceAll: params.replace_all === true,
      };
    }

    case 'write': {
      const content = str(params, 'content');
      if (content === undefined) return undefined;
      return { kind: 'write', path, content };
    }

    case 'read': {
      const text = input.resultText ?? '';
      if (!input.ok) {
        return {
          kind: 'read',
          path,
          unreadable: text
            ? rawText(text)
            : messageText('sessionWorkbenchUi.file.readFailed'),
        };
      }
      const { content, startLine } = parseNumberedRead(text);
      // 解析不出任何带行号的行 ⇒ 不装作能预览（可能是空文件提示）
      if (!content) {
        return {
          kind: 'read',
          path,
          unreadable: text
            ? rawText(text)
            : messageText('sessionWorkbenchUi.file.empty'),
        };
      }
      return { kind: 'read', path, content, startLine };
    }

    default:
      return undefined;
  }
}

/** 只有这两种会改盘上内容，进「审阅」的改动集 */
export function isMutation(op: FileOp): op is Extract<FileOp, { kind: 'edit' | 'write' }> {
  return op.kind === 'edit' || op.kind === 'write';
}
