/**
 * generate_image 工具：可批量并发生图、可长时间等待用户修改、
 * 最终一次性返回确认结果的普通工具。
 *
 * 执行语义：preflight → 创建审核节点 → 并发生成候选 → 审核动作循环
 * （IPC 只提交动作，重生成/commit 都在本 Promise 内执行）→ 唯一 tool_result。
 * 用户确认前 Promise 不 settle；Engine 一直 await，下一次 AI 请求自然不会发生。
 */

import fs from 'fs/promises';
import path from 'path';
import { BaseTool } from '../base-tool.js';
import type {
  ToolContext,
  ToolDef,
  ToolOutput,
} from '../types.js';
import { bool, z } from '../params.js';
import type { ImageGenerationSpecItem, ImageCommitOutcome } from './image-review-types.js';
import type { ImageNodeState } from '../../../shared/types/index.js';

/** 单次调用图片数量上限（schema 与 execute 双层强制） */
const MAX_IMAGES_PER_CALL = 10;

interface RawImageInput {
  prompt?: unknown;
  size?: unknown;
  outputPath?: unknown;
  overwrite?: unknown;
}

const generateImageSchema = z.object({
  images: z.array(z.object({
    prompt: z.string().min(1)
      .describe('可直接用于图片生成的描述。准确保留用户要求，使用英文按需写明主体、场景、构图、风格、光线、色彩和质感；需要出现在画面中的文字保持用户指定原文'),
    outputPath: z.string().min(1)
      .describe('最终图片文件的绝对路径（含文件名与扩展名）。用户明确给出目标路径时必须使用该路径；用户只给目录或项目目标时，在工作区内选择有业务含义的文件名。同批内路径不得重复'),
    size: z.string().regex(/^\d+x\d+$/).optional()
      .describe('图片尺寸（可选），宽x高像素格式：如 "1024x1024"、"1024x1792"、"1792x1024"。不要传 "16:9" 之类比例格式'),
    overwrite: bool().optional()
      .describe('目标文件已存在时是否覆盖（默认 false：已存在则在生成前失败）'),
  })).min(1).max(MAX_IMAGES_PER_CALL)
    .describe(`要生成的图片列表（1-${MAX_IMAGES_PER_CALL} 张，一次调用内并发生成；更多图片请拆分为多次调用）`),
});
type GenerateImageParams = z.infer<typeof generateImageSchema>;

export class GenerateImageTool extends BaseTool<GenerateImageParams> {
  readonly def: ToolDef<GenerateImageParams> = {
    name: 'generate_image',
    scope: 'shared',
    effects: ['write-fs'],
    schema: generateImageSchema,
    description: '需要生成一张或多张图片时调用。通过 images 提交要生成的图片，' +
      '每张图片指定 prompt 和最终文件的绝对路径 outputPath。',
  };

  async execute(
    params: GenerateImageParams,
    context: ToolContext,
  ): Promise<ToolOutput<unknown>> {
    const ops = context.imageOps;
    if (!ops) {
      return this.error('当前 Agent 未启用图片模块，无法生成图片');
    }
    if (!ops.isConfigured()) {
      return this.error('图片生成服务未配置。请在 设置 → 生图配置 中添加供应商。');
    }

    // ── 预检：一切校验失败都发生在任何 Provider 请求/候选目录创建之前 ──
    const preflight = await this.preflight(params.images);
    if (typeof preflight === 'string') {
      return this.error(preflight);
    }

    const node = ops.createReviewNode(preflight);
    await ops.generateInitialCandidates(node.id, context.signal);

    // 全部候选都失败时没有可审核内容，直接走终态结果，避免工具永久等待用户动作。
    if (node.images.length > 0 && node.images.every((image) => image.status === 'error')) {
      context.signal?.throwIfAborted();
      const outcome = await ops.commit(node.id, context.signal);
      context.signal?.throwIfAborted();
      return this.buildFinalResult(node.id, node, outcome);
    }

    // ── 审核动作循环：IPC 只提交动作，所有耗时操作都在本 Promise 内 ──
    for (;;) {
      const action = await ops.waitForReviewAction(node.id);
      context.signal?.throwIfAborted();   // 审核 Promise 返回后检查（防御层）

      if (action.type === 'regenerate') {
        await ops.regenerate(node.id, action, context.signal);
        continue;   // 回到 pending_approval，等待下一条动作
      }

      if (action.type === 'approve') {
        context.signal?.throwIfAborted();   // 最终 commit 前检查
        const outcome = await ops.commit(node.id, context.signal);
        context.signal?.throwIfAborted();   // 构建成功 tool result 前检查
        // 全部成功时节点已随审核会话关闭（getNode 返 undefined），用持有的同一活引用读 deletedCount
        return this.buildFinalResult(node.id, node, outcome);
      }

      ops.cancelReview(node.id, action.reason);
      return this.buildCancelledResult(node.id, ops.getNode(node.id), action.reason);
    }
  }

  /** 预检与归一化：返回错误文案或归一化输入 */
  private async preflight(raw: unknown): Promise<string | ImageGenerationSpecItem[]> {
    if (!Array.isArray(raw) || raw.length === 0) {
      return '缺少必需参数: images（至少包含一张图片）';
    }
    if (raw.length > MAX_IMAGES_PER_CALL) {
      return `单次调用最多生成 ${MAX_IMAGES_PER_CALL} 张图片（当前 ${raw.length} 张）。请拆分为多次 generate_image 调用`;
    }

    const items: ImageGenerationSpecItem[] = [];
    const seenPaths = new Set<string>();

    for (let i = 0; i < raw.length; i++) {
      const input = raw[i] as RawImageInput;
      if (typeof input?.prompt !== 'string' || input.prompt.trim() === '') {
        return `第 ${i + 1} 张图片缺少 prompt`;
      }
      if (typeof input.outputPath !== 'string' || input.outputPath.trim() === '') {
        return `第 ${i + 1} 张图片缺少 outputPath（最终图片文件的绝对路径）`;
      }
      if (!path.isAbsolute(input.outputPath)) {
        return `第 ${i + 1} 张图片的 outputPath 必须是绝对路径（收到: ${input.outputPath}）`;
      }

      const normalized = path.normalize(input.outputPath);
      if (seenPaths.has(normalized)) {
        return `同一次调用内 outputPath 重复: ${normalized}`;
      }
      seenPaths.add(normalized);

      const overwrite = input.overwrite === true;
      if (!overwrite) {
        // overwrite=false：目标已存在时在调用外部图片服务之前失败；
        // commit 时仍用排他创建兜底 TOCTOU
        try {
          await fs.access(normalized);
          return `目标文件已存在且未允许覆盖: ${normalized}（如需覆盖请设置 overwrite: true）`;
        } catch {
          // 不存在——正常路径
        }
      }

      items.push({
        prompt: input.prompt,
        size: typeof input.size === 'string' ? input.size : undefined,
        outputPath: normalized,
        overwrite,
      });
    }
    return items;
  }

  /** 确认路径的最终结果：completed / partial / failed */
  private buildFinalResult(
    nodeId: string,
    node: ImageNodeState | undefined,
    outcome: ImageCommitOutcome,
  ): ToolOutput<unknown> {
    const deletedCount = node?.deletedCount ?? 0;
    const data = {
      nodeId,
      status: outcome.status,
      images: outcome.committed,
      errors: outcome.errors,
      deletedCount,
    };

    const lines: string[] = [];
    if (outcome.status === 'completed') {
      lines.push(`图片生成完成：${outcome.committed.length} 张已写入最终路径。`);
    } else if (outcome.status === 'partial') {
      lines.push(
        `图片提交部分完成：${outcome.committed.length} 张成功、${outcome.errors.length} 张失败。`,
        '注意：成功项已产生正式文件；重试前先核对下方已成功路径，不得重复处理。',
      );
    } else {
      lines.push('图片生成或提交全部失败，未产生任何正式文件。');
    }
    for (const img of outcome.committed) {
      const notes: string[] = [];
      if (img.userInstruction) notes.push(`用户在审核中要求修改：「${img.userInstruction}」，已按用户意愿应用`);
      if (img.revisedPrompt) notes.push(`优化后 prompt: ${img.revisedPrompt}`);
      lines.push(`- [成功] ${img.outputPath}${notes.length > 0 ? `（${notes.join('；')}）` : ''}`);
    }
    for (const err of outcome.errors) {
      lines.push(`- [失败] ${err.outputPath}: ${err.error}`);
    }
    if (deletedCount > 0) {
      lines.push(`用户在审核中主动删除了 ${deletedCount} 张图片（不创建对应最终文件，无需补生成）。`);
    }

    // 不附图片内容块：图片已经用户人工审核，AI 无需视觉复检；路径是权威产物标识。
    // 整图 base64 进上下文会在每次后续请求中重发，且 OpenAI 协议下会被 transformer
    // 重新打包为伪 user 消息，诱发 AI 把成品当输入素材自发返工。UI 预览由日志层按路径读取。
    const resultText = lines.join('\n');

    if (outcome.status === 'completed') {
      return { ok: true, text: resultText, data };
    }
    return {
      ok: false,
      text: resultText,
      data,
    };
  }

  /** 用户取消：普通业务失败结果，不创建任何新的正式文件，Agent 继续 */
  private buildCancelledResult(
    nodeId: string,
    node: ImageNodeState | undefined,
    reason?: string,
  ): ToolOutput<unknown> {
    return {
      ok: false,
      text: `用户取消了本次图片生成${reason ? `（${reason}）` : ''}，未创建任何正式文件。`,
      data: {
        nodeId,
        status: 'cancelled',
        images: [],
        errors: [],
        deletedCount: node?.deletedCount ?? 0,
      },
    };
  }
}
