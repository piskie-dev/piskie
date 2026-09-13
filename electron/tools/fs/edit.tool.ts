import { BaseTool } from '../base-tool.js';
import { bool, z } from '../params.js';
import { REJECT } from '../pipeline/rejections.js';
import type {
  PreviewInfo,
  PreviewThunk,
  ToolContext,
  ToolDef,
  ToolOutput,
} from '../types.js';
import { formatDiffStat, unifiedDiff, type FileDiff } from './_lib/diff.js';
import { encodeText } from './_lib/encoding.js';
import { readMutationText, writeAtomic } from './_lib/file-io.js';
import { containsLineNumberPrefix } from './_lib/line-numbers.js';

const MAX_EDITS_PER_CALL = 50;

const editItemSchema = z.object({
  old_string: z.string().min(1).describe(
    'Exact text to replace, as it reads after the preceding edits have been applied. '
    + 'Copy file content without the line-number-and-tab prefix shown by read.',
  ),
  new_string: z.string().describe('Exact replacement text.'),
  replace_all: bool().default(false).describe(
    'Replace every match of this edit. When false, old_string must occur exactly once.',
  ),
});

const editSchema = z.object({
  file_path: z.string().min(1).describe('Absolute path of the file to edit.'),
  edits: z.array(editItemSchema).min(1).max(MAX_EDITS_PER_CALL).describe(
    'Ordered list of replacements for this file, applied in one call. Each edit is matched '
    + 'against the result of the previous one. Put all changes to this file here instead of '
    + 'making one call per change.',
  ),
});

type EditParams = z.infer<typeof editSchema>;
type EditItem = z.infer<typeof editItemSchema>;
type MatchMode = 'exact' | 'trailing_whitespace' | 'surrounding_whitespace';
type EditData = Readonly<{
  path: string;
  /** 本次调用应用的 edit 条数 */
  edits: number;
  /** 全部 edit 合计替换的位置数 */
  replacements: number;
  /** 逐条 edit 实际使用的匹配模式，与 params.edits 对齐 */
  matchModes: readonly MatchMode[];
  diff: FileDiff;
}>;

type Match = Readonly<{ start: number; end: number }>;
type EditPlan = Readonly<{
  content: string;
  replacements: number;
  matchModes: readonly MatchMode[];
  diff: FileDiff;
}>;

const DESCRIPTION = `Replace text in one existing file. Read the file first. Put every change to this file into the edits list of a single call: edits are applied in order, each one against the result of the previous one, and nothing is written unless every old_string matches. Each old_string must match exactly once at the time it is applied unless replace_all is true. After a successful call you can keep editing the same file without reading it again. Use write to create files.

old_string and new_string are literal text; never copy the line-number prefix shown by read. Matching tries exact text first, then ignores trailing line whitespace, then surrounding line whitespace; any fallback is reported.`;

export class EditTool extends BaseTool<EditParams, EditData> {
  readonly def: ToolDef<EditParams> = {
    name: 'edit',
    description: DESCRIPTION,
    schema: editSchema,
    scope: 'shared',
    effects: ['read-fs', 'write-fs'],
    policy: {
      pathParams: { file_path: 'absolute' },
      mutation: { pathParam: 'file_path', priorRead: 'required' },
    },
  };

  async prepare(params: EditParams): Promise<PreviewThunk> {
    return async (): Promise<PreviewInfo> => {
      const current = await readMutationText(params.file_path);
      if (current.kind === 'missing') {
        return {
          type: 'text',
          title: `Edit unavailable: ${params.file_path}`,
          content: `File not found: ${params.file_path}`,
        };
      }
      const plan = planEdits(params, current.text);
      if (typeof plan === 'string') {
        return { type: 'text', title: `Edit unavailable: ${params.file_path}`, content: plan };
      }
      return {
        type: 'diff',
        title: `Edit: ${params.file_path}`,
        content: plan.diff.unifiedDiff,
        stat: plan.diff.stat,
      };
    };
  }

  async execute(params: EditParams, ctx: ToolContext): Promise<ToolOutput<EditData>> {
    if (!ctx.files) return this.error('edit 缺少文件版本能力，这是内部错误。');

    try {
      const current = await readMutationText(params.file_path);
      if (current.kind === 'missing') {
        return this.error(REJECT.staleAtCommit(params.file_path));
      }

      const plan = planEdits(params, current.text);
      if (typeof plan === 'string') return this.error(plan);
      if (plan.content === current.text) {
        return this.error(`No changes made to ${params.file_path}: the edits leave the file unchanged.`);
      }

      const encoded = encodeText(plan.content, current.encoding);
      const committed = await writeAtomic({
        canonicalPath: params.file_path,
        content: encoded,
        files: ctx.files,
        expected: 'current',
      });
      if (!committed.ok) {
        return this.error(
          committed.reason === 'createdMeanwhile'
            ? REJECT.createdMeanwhile(params.file_path)
            : REJECT.staleAtCommit(params.file_path),
        );
      }

      // file_diff 唯一生产点：writeAtomic 成功之后的执行期事实，
      // data 与 artifact 引用同一份 plan.diff，不做第二次 diff 计算。
      return this.success(
        `已编辑 ${params.file_path}：应用 ${params.edits.length} 条 edit，共替换 ${plan.replacements} 处`
          + `${describeFallbacks(plan.matchModes)}（${formatDiffStat(plan.diff.stat)}）。`,
        {
          path: params.file_path,
          edits: params.edits.length,
          replacements: plan.replacements,
          matchModes: plan.matchModes,
          diff: plan.diff,
        },
        [{
          kind: 'file_diff',
          payload: {
            path: params.file_path,
            unifiedDiff: plan.diff.unifiedDiff,
            stat: plan.diff.stat,
          },
        }],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.error(`编辑 ${params.file_path} 失败：${message}`);
    }
  }
}

/**
 * 在内存里按顺序应用全部 edit：第 i 条在第 i−1 条的结果上匹配，任一条失败整批不落盘。
 * diff 为原文到终态的一份净 diff。
 */
function planEdits(params: EditParams, original: string): EditPlan | string {
  const total = params.edits.length;
  let content = original;
  let replacements = 0;
  const matchModes: MatchMode[] = [];

  for (const [index, edit] of params.edits.entries()) {
    const found = findMatches(content, edit.old_string);
    if (found.matches.length === 0) {
      return describeNotFound(params.file_path, edit, index, total, original);
    }
    if (!edit.replace_all && found.matches.length !== 1) {
      return `第 ${index + 1} 条 edit 的 old_string 在 ${params.file_path} 中匹配 ${found.matches.length} 处；`
        + '本次未写入任何修改。请增加上下文使其唯一，或为这条设置 replace_all=true。';
    }
    const selected = edit.replace_all ? found.matches : found.matches.slice(0, 1);
    for (const match of [...selected].reverse()) {
      content = content.slice(0, match.start) + edit.new_string + content.slice(match.end);
    }
    replacements += selected.length;
    matchModes.push(found.mode);
  }

  return {
    content,
    replacements,
    matchModes,
    diff: unifiedDiff(params.file_path, original, content),
  };
}

function describeNotFound(
  filePath: string,
  edit: EditItem,
  index: number,
  total: number,
  original: string,
): string {
  const lineHint = containsLineNumberPrefix(edit.old_string)
    ? ' old_string 看起来包含 read 输出的“行号 + TAB”前缀；请去掉前缀后重试。'
    : '';
  // 原文里有、当前内容里没有：被前面的 edit 改掉了，模型需要按应用后的内容重写这条
  const consumedHint = index > 0 && findMatches(original, edit.old_string).matches.length > 0
    ? ' 该文本在原文中存在，但已被前面的 edit 改掉，请按前面 edit 应用后的内容重写这条 old_string。'
    : '';
  return `Edit ${index + 1} of ${total}: old_string not found in ${filePath}. Nothing was written.`
    + `${lineHint}${consumedHint}`;
}

/** 成功文案里的容错说明：单条时不带序号，多条时指出第几条 */
function describeFallbacks(modes: readonly MatchMode[]): string {
  const notes: string[] = [];
  modes.forEach((mode, index) => {
    if (mode === 'exact') return;
    const label = mode === 'trailing_whitespace' ? '忽略行尾空白' : '忽略行首尾空白';
    notes.push(modes.length === 1 ? `使用${label}匹配` : `第 ${index + 1} 条使用${label}匹配`);
  });
  return notes.length > 0 ? `，${notes.join('，')}` : '';
}

function findMatches(
  content: string,
  needle: string,
): { mode: MatchMode; matches: Match[] } {
  const exact = literalMatches(content, needle);
  if (exact.length > 0) return { mode: 'exact', matches: exact };

  const trailing = lineMatches(content, needle, (line) => line.replace(/[ \t]+$/u, ''));
  if (trailing.length > 0) return { mode: 'trailing_whitespace', matches: trailing };

  return {
    mode: 'surrounding_whitespace',
    matches: lineMatches(content, needle, (line) => line.trim()),
  };
}

function literalMatches(content: string, needle: string): Match[] {
  const matches: Match[] = [];
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const start = content.indexOf(needle, offset);
    if (start < 0) break;
    matches.push({ start, end: start + needle.length });
    offset = start + needle.length;
  }
  return matches;
}

type SourceLine = Readonly<{ body: string; start: number; end: number; newlineEnd: number }>;

function lineMatches(
  content: string,
  needle: string,
  normalize: (line: string) => string,
): Match[] {
  const source = splitLines(content);
  const needleEndsWithNewline = /\r?\n$/u.test(needle);
  const needleLines = needle.split(/\r?\n/u);
  if (needleEndsWithNewline) needleLines.pop();
  if (needleLines.length === 0) return [];

  const matches: Match[] = [];
  for (let index = 0; index + needleLines.length <= source.length; index++) {
    let matchesAtIndex = true;
    for (let part = 0; part < needleLines.length; part++) {
      if (normalize(source[index + part].body) !== normalize(needleLines[part])) {
        matchesAtIndex = false;
        break;
      }
    }
    if (!matchesAtIndex) continue;
    const first = source[index];
    const last = source[index + needleLines.length - 1];
    matches.push({
      start: first.start,
      end: needleEndsWithNewline ? last.newlineEnd : last.end,
    });
    index += needleLines.length - 1;
  }
  return matches;
}

function splitLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) !== 10) continue;
    const rawEnd = index > start && content.charCodeAt(index - 1) === 13 ? index - 1 : index;
    lines.push({ body: content.slice(start, rawEnd), start, end: rawEnd, newlineEnd: index + 1 });
    start = index + 1;
  }
  if (start < content.length) {
    lines.push({ body: content.slice(start), start, end: content.length, newlineEnd: content.length });
  }
  return lines;
}
