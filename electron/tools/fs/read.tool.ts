import * as path from 'node:path';
import { BaseTool } from '../base-tool.js';
import { int, z } from '../params.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import {
  looksBinaryFile,
  readBufferWithVersion,
  readTextRangeWithVersion,
} from './_lib/file-read.js';
import { numberLine } from './_lib/line-numbers.js';

const DEFAULT_LINE_LIMIT = 2_000;
const BYTE_BUDGET = 384 * 1024;
const MAX_WHOLE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_SOURCE_BYTES = Math.floor(5 * 1024 * 1024 * 3 / 4);

const readSchema = z.object({
  file_path: z.string().min(1).describe('Absolute path to the file to read.'),
  offset: int(z.positive()).default(1)
    .describe('1-based line number to start reading from.'),
  limit: int(z.positive()).default(DEFAULT_LINE_LIMIT)
    .describe('Maximum number of lines to return. Defaults to 2000.'),
});

type ReadParams = z.infer<typeof readSchema>;

type ReadData = Readonly<{
  totalLines?: number;
  linesShown?: number;
  nextOffset?: number;
  mimeType?: string;
}>;

const DESCRIPTION = `Read a file from an absolute path.

Text output is numbered with a 1-based line number and a tab. Use offset and limit when only a section is needed. A call reads at most 2000 lines and 384KB by default, and tells you exactly how to continue when more lines exist. Do not copy the line-number prefix into edit old_string or new_string. Files you just changed with write or edit do not need to be reread merely to verify the change.

PNG, JPEG, GIF, and WEBP images are returned as images. PDF, audio, video, and unsupported binary formats are reported honestly; convert them with shell before reading.`;

export class ReadTool extends BaseTool<ReadParams, ReadData> {
  readonly def: ToolDef<ReadParams> = {
    name: 'read',
    description: DESCRIPTION,
    schema: readSchema,
    scope: 'shared',
    effects: ['read-fs'],
    policy: {
      pathParams: { file_path: 'absolute' },
      records: { pathParam: 'file_path' },
    },
  };

  async execute(params: ReadParams, ctx: ToolContext): Promise<ToolOutput<ReadData>> {
    if (!ctx.files) return this.error('read 缺少文件版本能力，这是内部错误。');

    const mimeType = mimeForPath(params.file_path);
    try {
      if (isSupportedImage(mimeType)) {
        return await this.readImage(params.file_path, mimeType, ctx);
      }
      const binary = isUnsupportedMedia(mimeType)
        ? true
        : await looksBinaryFile(params.file_path);
      if (binary === 'missing') return this.error(`File not found: ${params.file_path}`);
      if (binary) {
        return await this.describeUnsupported(params.file_path, mimeType, ctx);
      }

      const result = await readTextRangeWithVersion(params.file_path, ctx.files, {
        offset: params.offset,
        limit: params.limit,
        byteBudget: BYTE_BUDGET,
      });
      if (result.kind === 'missing') return this.error(`File not found: ${params.file_path}`);

      const numbered = result.lines
        .map((line, index) => numberLine(params.offset + index, line))
        .join('\n');
      const notes: string[] = [];
      if (result.overlongLine !== undefined) {
        notes.push(
          `第 ${result.overlongLine} 行超过本次字节预算（384KB），已在此处截断；`
          + '本工具只按行寻址，这一行没有续读方式。',
        );
      } else if (result.nextOffset !== undefined) {
        const shownEnd = params.offset + result.lines.length - 1;
        notes.push(
          `已显示 ${params.offset}-${shownEnd} 行（共 ${result.totalLines} 行）。`
          + `继续读：read({"file_path":${JSON.stringify(params.file_path)},"offset":${result.nextOffset}})`,
        );
      }
      if (!result.stable) {
        notes.push('该文件正在被并发修改；本次内容仍返回，但写入前必须重新 read。');
      }

      const text = [numbered || `(文件为空或 offset ${params.offset} 已超过文件末尾)`, ...notes]
        .filter(Boolean)
        .join('\n\n');
      return this.success(text, {
        totalLines: result.totalLines,
        linesShown: result.lines.length,
        nextOffset: result.nextOffset,
        mimeType,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.error(`读取 ${params.file_path} 失败：${message}`);
    }
  }

  private async readImage(
    filePath: string,
    mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
    ctx: ToolContext,
  ): Promise<ToolOutput<ReadData>> {
    const result = await readBufferWithVersion(filePath, ctx.files!, MAX_IMAGE_SOURCE_BYTES);
    if (result.kind === 'missing') return this.error(`File not found: ${filePath}`);
    if (result.kind === 'tooLarge') {
      return this.error(
        `图片 ${filePath} 为 ${formatBytes(result.bytes)}，base64 后会超过 5MB，无法送入模型。`,
        { mimeType },
      );
    }
    const concurrencyNote = result.stable ? '' : ' 文件读取期间发生变化，写入前请重新 read。';
    return {
      ok: true,
      text: `图片 ${filePath}（${mimeType}，${formatBytes(result.buffer.length)}）。${concurrencyNote}`,
      images: [{ base64: result.buffer.toString('base64'), mediaType: mimeType }],
      data: { mimeType },
    };
  }

  private async describeUnsupported(
    filePath: string,
    mimeType: string | undefined,
    ctx: ToolContext,
  ): Promise<ToolOutput<ReadData>> {
    const result = await readBufferWithVersion(filePath, ctx.files!, MAX_WHOLE_FILE_BYTES);
    if (result.kind === 'missing') return this.error(`File not found: ${filePath}`);
    const bytes = result.kind === 'tooLarge' ? result.bytes : result.buffer.length;
    return this.error(
      `${filePath} 存在（${mimeType ?? 'application/octet-stream'}，${formatBytes(bytes)}），`
      + '但 read 只能向模型返回文本或 PNG/JPEG/GIF/WEBP 图片。请先用 shell 转换为支持的格式。',
      { mimeType },
    );
  }
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.sqlite': 'application/vnd.sqlite3',
  '.db': 'application/octet-stream',
};

function mimeForPath(filePath: string): string | undefined {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

function isSupportedImage(
  value: string | undefined,
): value is 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  return value === 'image/png'
    || value === 'image/jpeg'
    || value === 'image/gif'
    || value === 'image/webp';
}

function isUnsupportedMedia(mimeType: string | undefined): boolean {
  return Boolean(
    mimeType?.startsWith('audio/')
    || mimeType?.startsWith('video/')
    || mimeType === 'application/pdf'
    || mimeType === 'application/zip'
    || mimeType === 'application/gzip'
    || mimeType === 'application/x-7z-compressed'
    || mimeType === 'application/vnd.sqlite3'
    || mimeType === 'application/octet-stream',
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
