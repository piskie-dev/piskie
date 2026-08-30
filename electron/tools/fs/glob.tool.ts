import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BaseTool } from '../base-tool.js';
import { z } from '../params.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import { collectCapped } from './_lib/cap.js';
import { runRg, stderrSnippet } from './_lib/rg.js';

const MAX_FILES = 1_000;
const VCS_EXCLUDES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const;

const globSchema = z.object({
  pattern: z.string().trim().min(1).describe('Glob pattern for file paths.'),
  path: z.string().min(1).optional().describe(
    'Directory to search. Defaults to this agent workspace. Results are absolute paths.',
  ),
});

type GlobParams = z.infer<typeof globSchema>;
type GlobData = Readonly<{
  count: number;
  searchPath: string;
  pattern: string;
  truncated: boolean;
}>;

const DESCRIPTION = `Find files by glob pattern using ripgrep. Results are absolute paths ordered by modification time, newest first.

The optional path defaults to this agent's workspace. Hidden and ignored files are searched, while VCS metadata and node_modules are excluded. This matches files, not directories; use "directory/**" to find a directory's contents. Results stop at 1000 files or after 15 seconds, with an explicit notice.`;

export class GlobTool extends BaseTool<GlobParams, GlobData> {
  readonly def: ToolDef<GlobParams> = {
    name: 'glob',
    description: DESCRIPTION,
    schema: globSchema,
    scope: 'shared',
    effects: ['read-fs'],
    policy: { pathParams: { path: 'workspace-default' } },
  };

  async execute(params: GlobParams, ctx: ToolContext): Promise<ToolOutput<GlobData>> {
    const split = splitAbsolutePattern(params.pattern);
    const searchPath = split?.searchDir ?? params.path ?? ctx.workspace.dir;
    const pattern = split?.relativePattern ?? params.pattern;

    try {
      const stat = await fs.stat(searchPath);
      if (!stat.isDirectory()) return this.error(`Path is not a directory: ${searchPath}`);

      const files: string[] = [];
      const outcome = await runRg(buildRgGlobArgs(pattern), {
        cwd: searchPath,
        signal: ctx.signal,
        onLine: (line) => {
          if (!line) return;
          files.push(path.resolve(searchPath, line));
          if (files.length > MAX_FILES) return false;
        },
      });
      if (outcome.terminated === 'abort') return this.error('File matching aborted.');
      if (
        outcome.terminated === null
        && outcome.exitCode !== 0
        && outcome.exitCode !== 1
        && files.length === 0
        && outcome.stderr.trim() !== ''
      ) {
        return this.error(
          `ripgrep failed (exit ${outcome.exitCode}): ${stderrSnippet(outcome.stderr)}`,
        );
      }

      const page = await collectCapped(asAsync(files), {
        limit: MAX_FILES,
        render: (file) => file,
        empty: 'No files found',
        more: (shown) => `已列 ${shown} 条（已达上限）。收窄 pattern 或传 path 缩小范围。`,
      });
      const truncated = page.truncated || outcome.terminated !== null;
      const text = truncated && !page.truncated
        ? `${page.text}\n\n扫描在 15 秒或资源上限处停止；以上是已找到的部分结果。`
        : page.text;
      return this.success(text, {
        count: page.count,
        searchPath,
        pattern,
        truncated,
      });
    } catch (error) {
      if (isNotFound(error)) return this.error(`Directory not found: ${searchPath}`);
      const message = error instanceof Error ? error.message : String(error);
      return this.error(`文件匹配失败：${message}`);
    }
  }
}

export function splitAbsolutePattern(
  pattern: string,
): { searchDir: string; relativePattern: string } | null {
  if (!path.isAbsolute(pattern)) return null;
  const segments = pattern.replace(/\\/g, '/').split('/');
  let firstMeta = segments.findIndex((segment) => /[*?[\]{}]/u.test(segment));
  if (firstMeta < 0) firstMeta = segments.length - 1;
  return {
    searchDir: segments.slice(0, firstMeta).join('/') || '/',
    relativePattern: segments.slice(firstMeta).join('/'),
  };
}

export function buildRgGlobArgs(pattern: string): string[] {
  const args = ['--files', '--glob', pattern, '--sortr=modified', '--no-ignore', '--hidden'];
  for (const directory of VCS_EXCLUDES) args.push('--glob', `!**/${directory}/**`);
  args.push(
    '--glob', '!**/node_modules/**',
    '--glob-case-insensitive',
    '--no-messages',
    '--no-follow',
  );
  return args;
}

async function* asAsync<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
