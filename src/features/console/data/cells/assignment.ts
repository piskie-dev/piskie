/**
 * 任务分派消息的解析 —— 把 worker 的第一条消息从 XML 包装里拆出来。
 *
 * 后端发给 worker 的首条消息形如（`electron/agent/assignment-message.ts`）：
 *
 * ```
 * <assignment>
 *   <prompt>
 * {人读的任务正文}
 *   </prompt>
 * </assignment>
 *
 * <task_board summary="...">
 *   <item id="..." subject="..." .../>
 * </task_board>
 * ```
 *
 * 这套 XML 是**给模型看的框**，不是给人看的内容：整段原文当正文渲染的话，worker 一出现，
 * 第一屏就是 `<assignment>` / `<prompt>` 加一大段 prompt。所以拆开：
 * - `prompt` 进正文（两个模式共用；dock 的 120 字摘要也因此不再以 `<assignment>` 开头）
 * - `taskBoard` 只进 debug 段 —— 它的人读形态本来就是右栏的任务看板，正文里重复一遍没有意义，
 *   但也不能直接丢，否则"日志里能看到的东西"变少了
 *
 * **解析失败一律回退原文**：宁可显示得丑，也不要静默丢掉一条消息的内容。
 */

export interface ParsedAssignment {
  /** 人读的任务正文；解析失败时是原文 */
  readonly prompt: string;
  /** 原始 `<task_board>` 片段（含标签），没有则 undefined */
  readonly taskBoard?: string;
  /** 是否成功识别出 XML 包装（false = 走了原文回退） */
  readonly parsed: boolean;
}

const ASSIGNMENT_RE = /<assignment>\s*<prompt>\s*([\s\S]*?)\s*<\/prompt>\s*<\/assignment>/;
const TASK_BOARD_RE = /<task_board[\s\S]*?<\/task_board>/;

/**
 * 还原 `neutralizeAssignmentClosings` 的转义：后端把正文里的 `</prompt>` 一类写成
 * `<\/prompt>` 以免提前闭合外层标签，这里要反过来，否则用户看到的是带反斜杠的怪字符串。
 */
function deneutralize(text: string): string {
  return text.replace(/<\\\/(prompt|assignment|task_board)>/g, '</$1>');
}

export function parseAssignment(raw: string): ParsedAssignment {
  const match = ASSIGNMENT_RE.exec(raw);
  const taskBoard = TASK_BOARD_RE.exec(raw)?.[0];

  if (!match) {
    // 没有包装：原样用，不做任何猜测
    return { prompt: raw, taskBoard, parsed: false };
  }

  return { prompt: deneutralize(match[1] ?? '').trim(), taskBoard, parsed: true };
}
