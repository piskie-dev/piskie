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

const editSchema = z.object({
  file_path: z.string().min(1).describe('Absolute path of the file to edit.'),
  old_string: z.string().min(1).describe(
    'Exact text to replace. Copy file content without the line-number-and-tab prefix shown by read.',
  ),
  new_string: z.string().describe('Exact replacement text.'),
  replace_all: bool().default(false).describe(
    'Replace every match. When false, old_string must occur exactly once.',
  ),
});

type EditParams = z.infer<typeof editSchema>;
type MatchMode = 'exact' | 'trailing_whitespace' | 'surrounding_whitespace';
type EditData = Readonly<{
  path: string;
  replacements: number;
  matchMode: MatchMode;
  diff: FileDiff;
}>;

type Match = Readonly<{ start: number; end: number }>;
type EditPlan = Readonly<{
  content: string;
  replacements: number;
  matchMode: MatchMode;
  diff: FileDiff;
}>;

const DESCRIPTION = `Replace text in an existing file at an absolute path. Read the file first.

old_string and new_string are literal text; never copy the six-character line-number prefix shown by read (the prefix ends with a TAB). By default old_string must identify exactly one occurrence. Set replace_all=true only when every occurrence should change. Matching tries exact text first, then ignores trailing line whitespace, then surrounding line whitespace; any fallback is reported. Use write to create files.`;

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
      const plan = planEdit(params, current.text);
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

      const plan = planEdit(params, current.text);
      if (typeof plan === 'string') return this.error(plan);
      if (plan.content === current.text) {
        return this.error(`No changes made to ${params.file_path}: replacement text is unchanged.`);
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

      const fallback = plan.matchMode === 'exact'
        ? ''
        : `，使用 ${plan.matchMode === 'trailing_whitespace' ? '忽略行尾空白' : '忽略行首尾空白'} 匹配`;
      // file_diff 唯一生产点：writeAtomic 成功之后的执行期事实，
      // data 与 artifact 引用同一份 plan.diff，不做第二次 diff 计算。
      return this.success(
        `已编辑 ${params.file_path}：替换 ${plan.replacements} 处${fallback}（${formatDiffStat(plan.diff.stat)}）。`,
        {
          path: params.file_path,
          replacements: plan.replacements,
          matchMode: plan.matchMode,
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

function planEdit(params: EditParams, current: string): EditPlan | string {
  const found = findMatches(current, params.old_string);
  if (found.matches.length === 0) {
    const lineHint = containsLineNumberPrefix(params.old_string)
      ? ' old_string 看起来包含 read 输出的“行号 + TAB”前缀；请去掉前缀后重试。'
      : '';
    return `No occurrences of old_string found in ${params.file_path}.${lineHint}`;
  }
  if (!params.replace_all && found.matches.length !== 1) {
    return `old_string 在 ${params.file_path} 中匹配 ${found.matches.length} 处。`
      + '请增加上下文使其唯一，或明确设置 replace_all=true。';
  }

  const selected = params.replace_all ? found.matches : found.matches.slice(0, 1);
  let content = current;
  for (const match of [...selected].reverse()) {
    content = content.slice(0, match.start) + params.new_string + content.slice(match.end);
  }
  return {
    content,
    replacements: selected.length,
    matchMode: found.mode,
    diff: unifiedDiff(params.file_path, current, content),
  };
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
