import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BaseTool } from '../base-tool.js';
import { bool, int, z } from '../params.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import { runRg, stderrSnippet } from './_lib/rg.js';
import { renderGrepText, type GrepOutputMode } from './grep-text.js';

const DEFAULT_HEAD_LIMIT = 250;
const MAX_FILE_SIZE = '20M';
const MAX_COLUMNS = 2_000;
const VCS_EXCLUDES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const;

const nonnegativeInt = () => int(z.nonnegative());
const grepSchema = z.object({
  pattern: z.string().min(1).describe('Ripgrep regular expression to search for.'),
  path: z.string().min(1).optional().describe(
    'File or directory to search. Defaults to this agent workspace.',
  ),
  glob: z.string().min(1).optional().describe('File glob filter, such as "*.ts".'),
  type: z.string().min(1).optional().describe('Ripgrep file type, such as js, py, or rust.'),
  output_mode: z.enum(['content', 'files_with_matches', 'count'])
    .default('files_with_matches'),
  '-i': bool().default(false).describe('Case-insensitive search.'),
  '-n': bool().default(true).describe('Show line numbers in content mode.'),
  '-A': nonnegativeInt().optional().describe('Lines after each match in content mode.'),
  '-B': nonnegativeInt().optional().describe('Lines before each match in content mode.'),
  '-C': nonnegativeInt().optional().describe('Lines before and after each match in content mode.'),
  head_limit: nonnegativeInt().default(DEFAULT_HEAD_LIMIT)
    .describe('Maximum returned lines or entries. Pass 0 for unlimited.'),
  offset: nonnegativeInt().default(0).describe('Entries to skip before applying head_limit.'),
  multiline: bool().default(false).describe('Enable multiline matching.'),
});

type GrepParams = z.infer<typeof grepSchema>;
type GrepData = Readonly<{
  mode: GrepOutputMode;
  count: number;
  searchPath: string;
  offset: number;
  truncated: boolean;
}>;

const DESCRIPTION = `A powerful content search tool built on ripgrep.

Use this instead of invoking grep or rg through shell. It supports ripgrep regex syntax, glob/type filters, content/files_with_matches/count output modes, context lines, pagination, and multiline matching. Returned paths are absolute. Hidden files are searched, .gitignore is respected, and VCS metadata is excluded. Lines over 2000 columns are omitted and files over 20MB are skipped. Searches stop after 15 seconds and return the collected portion with a continuation notice.`;

export class GrepTool extends BaseTool<GrepParams, GrepData> {
  readonly def: ToolDef<GrepParams> = {
    name: 'grep',
    description: DESCRIPTION,
    schema: grepSchema,
    scope: 'shared',
    effects: ['read-fs'],
    policy: { pathParams: { path: 'workspace-default' } },
  };

  async execute(params: GrepParams, ctx: ToolContext): Promise<ToolOutput<GrepData>> {
    const searchPath = params.path ?? ctx.workspace.dir;
    try {
      const stat = await fs.stat(searchPath);
      const isFile = stat.isFile();
      if (!stat.isDirectory() && !isFile) {
        return this.error(`Search path is neither a file nor directory: ${searchPath}`);
      }

      const cwd = isFile ? path.dirname(searchPath) : searchPath;
      const positional = isFile ? `./${path.basename(searchPath)}` : '.';
      const limit = params.head_limit === 0 ? Number.POSITIVE_INFINITY : params.head_limit;
      const lines: string[] = [];
      let skipped = 0;
      let hasMore = false;

      const outcome = await runRg(buildRgGrepArgs(params, positional, isFile), {
        cwd,
        signal: ctx.signal,
        onLine: (line) => {
          if (skipped < params.offset) {
            skipped++;
            return;
          }
          if (lines.length >= limit) {
            hasMore = true;
            return false;
          }
          lines.push(absolutizeLine(line, cwd, params.output_mode));
        },
      });
      if (outcome.terminated === 'abort') return this.error('Search aborted.');
      if (
        outcome.terminated === null
        && outcome.exitCode !== 0
        && outcome.exitCode !== 1
        && lines.length === 0
        && outcome.stderr.trim() !== ''
      ) {
        return this.error(
          `ripgrep failed (exit ${outcome.exitCode}): ${stderrSnippet(outcome.stderr)}`,
        );
      }

      const externallyTruncated = outcome.terminated !== null && outcome.terminated !== 'early-stop';
      const page = renderGrepText({
        mode: params.output_mode,
        lines,
        limit: params.head_limit,
        hasMore: hasMore || externallyTruncated,
        nextOffset: params.offset + lines.length,
      });
      const text = externallyTruncated
        ? `${page.text}\n\n扫描在 15 秒或资源上限处停止；以上是已找到的部分结果。`
        : page.text;
      return this.success(text, {
        mode: params.output_mode,
        count: page.count,
        searchPath,
        offset: params.offset,
        truncated: page.truncated,
      });
    } catch (error) {
      if (isNotFound(error)) return this.error(`Search path does not exist: ${searchPath}`);
      const message = error instanceof Error ? error.message : String(error);
      return this.error(`搜索失败：${message}`);
    }
  }
}

export function buildRgGrepArgs(
  params: GrepParams,
  positional: string,
  isFile: boolean,
): string[] {
  const args: string[] = [];
  if (params.output_mode === 'files_with_matches') {
    args.push('-l');
  } else if (params.output_mode === 'count') {
    args.push('-c');
  } else {
    if (params['-n']) args.push('-n');
    if (params['-C'] !== undefined) args.push('-C', String(params['-C']));
    if (params['-A'] !== undefined) args.push('-A', String(params['-A']));
    if (params['-B'] !== undefined) args.push('-B', String(params['-B']));
    args.push('--no-heading', '--max-columns', String(MAX_COLUMNS));
  }
  if (params['-i']) args.push('-i');
  if (params.multiline) args.push('-U', '--multiline-dotall');
  if (isFile) args.push('-H');
  args.push('--hidden');
  for (const directory of VCS_EXCLUDES) args.push('--glob', `!**/${directory}/**`);
  args.push('--max-filesize', MAX_FILE_SIZE, '--no-messages', '--no-follow');
  if (params.type) args.push('--type', params.type);
  if (params.glob) args.push('--glob', params.glob);
  args.push('-e', params.pattern, positional);
  return args;
}

function absolutizeLine(line: string, cwd: string, mode: GrepOutputMode): string {
  if (mode === 'files_with_matches') return path.resolve(cwd, line);
  if (line.startsWith('./') || line.startsWith('.\\')) {
    return path.join(cwd, line.slice(2));
  }
  return line;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
