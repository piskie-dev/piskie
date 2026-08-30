import { BaseTool } from '../base-tool.js';
import { z } from '../params.js';
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
import { appLog } from '../../observability/logging/app-log.js';

const writeSchema = z.object({
  file_path: z.string().min(1).describe('Absolute path of the file to write.'),
  content: z.string().describe('Complete content for the file.'),
});

type WriteParams = z.infer<typeof writeSchema>;
type WriteData = Readonly<{
  path: string;
  isNewFile: boolean;
  bytesWritten: number;
  diff: FileDiff;
}>;

const DESCRIPTION = `Write complete content to a file at an absolute path, creating parent directories automatically.

If the file already exists, read it first. The write is rejected when the current version differs from the version this agent read. Existing UTF-8 BOM and UTF-16 encoding is preserved. Use edit for a targeted replacement.`;

export class WriteTool extends BaseTool<WriteParams, WriteData> {
  readonly def: ToolDef<WriteParams> = {
    name: 'write',
    description: DESCRIPTION,
    schema: writeSchema,
    scope: 'shared',
    effects: ['write-fs'],
    policy: {
      pathParams: { file_path: 'absolute' },
      mutation: { pathParam: 'file_path', priorRead: 'if-exists' },
    },
  };

  async prepare(params: WriteParams): Promise<PreviewThunk> {
    return async (): Promise<PreviewInfo> => {
      const current = await readMutationText(params.file_path);
      const diff = unifiedDiff(params.file_path, current.text, params.content);
      return {
        type: 'diff',
        title: `${current.kind === 'missing' ? 'Create' : 'Write'}: ${params.file_path}`,
        content: diff.unifiedDiff,
        stat: diff.stat,
      };
    };
  }

  async execute(params: WriteParams, ctx: ToolContext): Promise<ToolOutput<WriteData>> {
    if (!ctx.files) return this.error('write 缺少文件版本能力，这是内部错误。');

    try {
      const current = await readMutationText(params.file_path);
      const isNewFile = current.kind === 'missing';
      const diff = unifiedDiff(params.file_path, current.text, params.content);
      const encoded = encodeText(params.content, current.encoding);

      if (!isNewFile && current.text === params.content) {
        return this.success(`未修改 ${params.file_path}（内容相同，${formatDiffStat(diff.stat)}）。`, {
          path: params.file_path,
          isNewFile: false,
          bytesWritten: 0,
          diff,
        });
      }

      const committed = await writeAtomic({
        canonicalPath: params.file_path,
        content: encoded,
        files: ctx.files,
        expected: isNewFile ? 'absent' : 'current',
        onWarning: (message, error) => appLog.warn({
          event: 'tool.write.atomic.degraded',
          message: 'Atomic file write degraded',
          context: {
            scope: 'tool.write',
            agentId: ctx.agentId,
            callId: ctx.callId,
            filePath: params.file_path,
            warningReason: message.slice(0, 240),
          },
          error,
        }),
      });
      if (!committed.ok) {
        return this.error(
          committed.reason === 'createdMeanwhile'
            ? REJECT.createdMeanwhile(params.file_path)
            : REJECT.staleAtCommit(params.file_path),
        );
      }

      return this.success(
        `${isNewFile ? '已创建' : '已写入'} ${params.file_path}（${encoded.length} bytes，${formatDiffStat(diff.stat)}）。`,
        {
          path: params.file_path,
          isNewFile,
          bytesWritten: encoded.length,
          diff,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.error(`写入 ${params.file_path} 失败：${message}`);
    }
  }
}
