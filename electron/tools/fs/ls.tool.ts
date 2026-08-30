import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BaseTool } from '../base-tool.js';
import { z } from '../params.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import { collectCapped } from './_lib/cap.js';

const MAX_ENTRIES = 500;

const lsSchema = z.object({
  path: z.string().min(1).optional().describe(
    'Directory to list. Defaults to this agent workspace.',
  ),
  ignore: z.array(z.string().min(1)).optional().describe(
    'Entry-name patterns to ignore. Only * and ? wildcards are supported.',
  ),
});

type LsParams = z.infer<typeof lsSchema>;
type LsData = Readonly<{ path: string; count: number; truncated: boolean }>;
type ListedEntry = Readonly<{
  name: string;
  absolutePath: string;
  directory: boolean;
  size?: number;
  modified?: Date;
  inaccessible?: boolean;
}>;

const DESCRIPTION = `List files and subdirectories directly inside one directory. This is non-recursive; use glob for recursive discovery.

The optional path defaults to this agent workspace. No entries are hidden implicitly. ignore matches entry names with only * and ? wildcards. At most 500 entries are returned, with a notice when more exist.`;

export class LsTool extends BaseTool<LsParams, LsData> {
  readonly def: ToolDef<LsParams> = {
    name: 'ls',
    description: DESCRIPTION,
    schema: lsSchema,
    scope: 'shared',
    effects: ['read-fs'],
    policy: { pathParams: { path: 'workspace-default' } },
  };

  async execute(params: LsParams, ctx: ToolContext): Promise<ToolOutput<LsData>> {
    const directory = params.path ?? ctx.workspace.dir;
    try {
      const stat = await fs.stat(directory);
      if (!stat.isDirectory()) return this.error(`Path is not a directory: ${directory}`);

      const page = await collectCapped(iterateEntries(directory, params.ignore), {
        limit: MAX_ENTRIES,
        empty: '(empty directory)',
        render: renderEntry,
        more: (shown) => `已列 ${shown} 条（已达上限）。用 glob 搜索或进入子目录继续查看。`,
      });
      return this.success(`目录: ${directory}\n${page.text}`, {
        path: directory,
        count: page.count,
        truncated: page.truncated,
      });
    } catch (error) {
      if (isNotFound(error)) return this.error(`Directory not found: ${directory}`);
      const message = error instanceof Error ? error.message : String(error);
      return this.error(`列出目录失败：${message}`);
    }
  }
}

async function* iterateEntries(
  directory: string,
  ignore: readonly string[] | undefined,
): AsyncIterable<ListedEntry> {
  const patterns = ignore?.map(wildcardPattern) ?? [];
  const handle = await fs.opendir(directory);
  try {
    for await (const entry of handle) {
      if (patterns.some((pattern) => pattern.test(entry.name))) continue;
      const absolutePath = path.join(directory, entry.name);
      try {
        const stat = await fs.lstat(absolutePath);
        yield {
          name: entry.name,
          absolutePath,
          directory: stat.isDirectory(),
          size: stat.isDirectory() ? undefined : stat.size,
          modified: stat.mtime,
        };
      } catch {
        yield {
          name: entry.name,
          absolutePath,
          directory: entry.isDirectory(),
          inaccessible: true,
        };
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function renderEntry(entry: ListedEntry): string {
  if (entry.inaccessible) return `${entry.absolutePath}${entry.directory ? '/' : ''} [unreadable]`;
  const timestamp = entry.modified?.toISOString() ?? 'unknown-time';
  return entry.directory
    ? `${entry.absolutePath}/ ${timestamp}`
    : `${entry.absolutePath} ${formatBytes(entry.size ?? 0)} ${timestamp}`;
}

function wildcardPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'u');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
