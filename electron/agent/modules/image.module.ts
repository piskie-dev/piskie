import { appLog } from '@electron/observability/logging/app-log.js';
import { createUuid } from '@shared/utils/identifiers.js';
/**
 * ImageModule：生图审核唯一状态源。
 *
 * - imageNodes Map + 每节点一个 pending 审核动作 Promise（不新增第二 registry）；
 * - IPC 只提交动作（submitReviewAction 校验 → resolve → 立即返回）；
 * - 生成/重生成/commit 全部在 generate_image 工具 Promise 内经 ImageReviewOps 执行；
 * - 候选文件在 OS 临时目录，协议自身零清理；
 * - commit 单文件原子、批次允许部分完成。
 */

import fs from 'fs/promises';
import path from 'path';

import type { AgentModule } from './module.js';
import type { AgentHost } from '../agent-host.js';
import type { ToolContextBuilder } from '../tool-context.js';
import type {
  ImageApplicationOutput,
  ImageApplicationPort,
  ImageApplicationSource,
} from '../../inference/application/image-application-port.js';
import type { ModelTarget } from '../../inference/execution/contracts.js';
import type {
  ImageItem,
  ImageNodeState,
  ImageNodePublicState,
} from '../../../shared/types/index.js';
import type {
  ImageGenerationSpecItem,
  ImageReviewAction,
  ImageCommitOutcome,
  ImageReviewOps,
} from '../../tools/image/image-review-types.js';
import { pathsService } from '../../services/paths.service.js';

/** auto 模式首轮预览时长 */
const PREVIEW_MS = 10_000;

/** 结算出口状态（没有任何出口回到 pending） */
const TERMINAL_STATUSES: ReadonlySet<ImageNodeState['status']> = new Set([
  'approved',
  'partial',
  'failed',
  'cancelled',
]);

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

interface PendingReviewAction {
  resolve: (action: ImageReviewAction) => void;
  reject: (reason: unknown) => void;
  previewTimer?: NodeJS.Timeout;
}

interface ActionSubmitResult {
  success: boolean;
  error?: string;
}

export class ImageModule implements AgentModule, ImageReviewOps {
  readonly name = 'image';
  private host!: AgentHost;
  private imageApplication?: ImageApplicationPort;
  private imageTarget?: ModelTarget;

  private imageNodes: Map<string, ImageNodeState> = new Map();
  private pendingReviewActions: Map<string, PendingReviewAction> = new Map();

  init(host: AgentHost, config: Record<string, unknown>): void {
    this.host = host;
    this.imageApplication = config.imageApplication as ImageApplicationPort | undefined;
    this.imageTarget = config.imageTarget as ModelTarget | undefined;
  }

  contributeTools(builder: ToolContextBuilder): void {
    builder.setImageOps(this);
  }

  onInterrupt(): void {
    this.failOutstandingReviews(new Error('操作已被用户中断'));
    let changed = false;
    for (const node of this.imageNodes.values()) {
      if (!TERMINAL_STATUSES.has(node.status)) {
        node.status = 'cancelled';
        node.previewDeadline = undefined;
        changed = true;
      }
    }
    if (changed) this.host.emitStateChange();
  }

  async onDestroy(): Promise<void> {
    this.failOutstandingReviews(new Error('ImageModule destroyed'));
    this.imageNodes.clear();
  }

  // ─── 公共查询 ──────────────────────────────────────────

  /** 公开投影：轻量路径状态，不携带 base64；getControlState 每次即时派生 */
  getPublicState(): ImageNodePublicState[] {
    return Array.from(this.imageNodes.values()).map((node) => ({
      id: node.id,
      status: node.status,
      target: node.target,
      previewDeadline: node.previewDeadline,
      createdAt: node.createdAt.getTime(),
      images: node.images.map((img) => ({
        id: img.id,
        prompt: img.prompt,
        outputPath: img.outputPath,
        candidatePath: img.candidatePath,
        mimeType: img.mimeType,
        version: img.version,
        status: img.status,
        error: img.error,
      })),
    }));
  }

  // ─── ImageReviewOps（generate_image 工具 Promise 内执行） ─────────

  isConfigured(): boolean {
    return (
      this.imageApplication !== undefined &&
      this.imageTarget !== undefined &&
      this.imageApplication.hasTarget(this.imageTarget)
    );
  }

  createReviewNode(items: ImageGenerationSpecItem[]): ImageNodeState {
    if (!this.imageApplication || !this.imageTarget) {
      throw new Error('未配置图片生成模型');
    }
    // 调用开始时捕获显式 target，同一批次不随配置热切换漂移。
    const target = { ...this.imageTarget };
    const node: ImageNodeState = {
      id: createUuid(),
      agentId: this.host.id,
      status: 'generating',
      images: items.map((item) => ({
        id: createUuid(),
        prompt: item.prompt,
        size: item.size,
        outputPath: item.outputPath,
        overwrite: item.overwrite,
        status: 'generating' as const,
        version: 0,
      })),
      createdAt: new Date(),
      target,
      deletedCount: 0,
    };
    this.imageNodes.set(node.id, node);
    this.host.emitStateChange();
    return node;
  }

  async generateInitialCandidates(nodeId: string, signal?: AbortSignal): Promise<void> {
    const node = this.mustGetNode(nodeId);
    await Promise.allSettled(
      node.images.map(async (img) => {
        try {
          signal?.throwIfAborted();
          const response = await this.imageApplication!.execute(
            {
              model: node.target,
              prompt: img.prompt,
              size: img.size,
              count: 1,
            },
            { signal }
          );

          const output = response.images[0];
          if (!output) throw new Error('供应商未返回图片数据');
          signal?.throwIfAborted(); // 写候选前检查：Stop 后迟到结果不落盘
          await this.writeCandidate(node, img, output);
          img.revisedPrompt = output.revisedPrompt;
          img.status = 'completed';
        } catch (err) {
          if (signal?.aborted) throw err; // abort 不吞成单图 error
          img.status = 'error';
          img.error = err instanceof Error ? err.message : String(err);
        } finally {
          this.host.emitStateChange();
        }
      })
    );
    // allSettled 单图失败不取消其他图片；abort 在此统一上抛，不得吞成"部分成功"
    signal?.throwIfAborted();
  }

  waitForReviewAction(nodeId: string): Promise<ImageReviewAction> {
    const node = this.imageNodes.get(nodeId);
    if (!node) return Promise.reject(new Error(`图片节点 ${nodeId} 不存在`));
    // 中断竞态防御：onInterrupt 先结算节点后，迟到的等待请求不得创建孤儿 pending
    if (TERMINAL_STATUSES.has(node.status)) {
      return Promise.reject(new Error('本次图片审核已结束'));
    }

    return new Promise<ImageReviewAction>((resolve, reject) => {
      const pending: PendingReviewAction = { resolve, reject };
      if (this.host.approvalMode === 'auto' && node.status === 'generating') {
        // auto 首轮：10 秒预览，倒计时到期与手动确认同路
        node.status = 'preview';
        node.previewDeadline = Date.now() + PREVIEW_MS;
        pending.previewTimer = setTimeout(() => {
          this.pendingReviewActions.delete(nodeId);
          resolve({ type: 'approve' });
        }, PREVIEW_MS);
      } else {
        node.status = 'pending_approval';
        node.previewDeadline = undefined;
      }
      this.pendingReviewActions.set(nodeId, pending);
      this.host.emitStateChange();
    });
  }

  async regenerate(
    nodeId: string,
    action: Extract<ImageReviewAction, { type: 'regenerate' }>,
    signal?: AbortSignal
  ): Promise<void> {
    const node = this.mustGetNode(nodeId);
    const targets = node.images.filter((img) => action.imageIds.includes(img.id));
    const prevStatus = new Map(targets.map((img) => [img.id, img.status]));

    node.status = 'regenerating';
    node.previewDeadline = undefined;
    for (const img of targets) {
      img.status = 'generating';
      img.error = undefined;
    }
    this.host.emitStateChange();

    const target = action.target ?? node.target;

    for (const img of targets) {
      signal?.throwIfAborted();
      const newPrompt = await this.rewritePrompt(img.prompt, action.instruction, signal);

      signal?.throwIfAborted();
      try {
        // 用户参考图优先；否则已有候选就是 edit 的源图。Catalog capability 不参与门禁。
        const sources: ImageApplicationSource[] = action.images?.length
          ? action.images.map((image) => ({
              bytes: Buffer.from(image.data, 'base64'),
              mimeType: image.media_type,
            }))
          : img.candidatePath
            ? [
                {
                  bytes: await fs.readFile(img.candidatePath),
                  mimeType: img.mimeType || 'image/png',
                  fileName: path.basename(img.candidatePath),
                },
              ]
            : [];
        const response = await this.imageApplication!.execute(
          {
            model: target,
            prompt: newPrompt,
            size: img.size,
            count: 1,
            ...(sources.length > 0 && { sources }),
          },
          { signal }
        );

        const output = response.images[0];
        if (!output) throw new Error('供应商未返回图片数据');
        signal?.throwIfAborted(); // 写候选前检查
        await this.writeCandidate(node, img, output); // 成功原子替换候选，version+1
        img.prompt = newPrompt;
        img.revisedPrompt = output.revisedPrompt;
        img.userInstruction = action.instruction;
        img.status = 'completed';
        img.error = undefined;
      } catch (err) {
        if (signal?.aborted) throw err; // 取消不降级为单图 error，诚实上抛
        // 失败保留旧候选只记录错误：candidatePath/version 未动
        img.status = prevStatus.get(img.id) === 'completed' ? 'completed' : 'error';
        img.error = err instanceof Error ? err.message : String(err);
        appLog.warn({
          event: 'agent.image.regenerate.degraded',
          message: 'Image regeneration degraded',
          context: { scope: 'agent.image', imageId: img.id },
          error: err,
        });
      }
      this.host.emitStateChange();
    }

    signal?.throwIfAborted();
    node.status = 'pending_approval';
    this.host.emitStateChange();
  }

  async commit(nodeId: string, signal?: AbortSignal): Promise<ImageCommitOutcome> {
    const node = this.mustGetNode(nodeId);
    node.status = 'committing';
    node.previewDeadline = undefined;
    this.host.emitStateChange();

    const committed: ImageCommitOutcome['committed'] = [];
    const errors: ImageCommitOutcome['errors'] = [];

    // commit 前统一重新校验：尽量在产生任何正式文件之前发现错误
    const ready: ImageItem[] = [];
    for (const img of node.images) {
      if (img.status !== 'completed' || !img.candidatePath) {
        errors.push({
          id: img.id,
          outputPath: img.outputPath,
          error: img.error || '没有可提交的候选图',
        });
        continue;
      }
      try {
        await fs.access(img.candidatePath);
      } catch {
        errors.push({
          id: img.id,
          outputPath: img.outputPath,
          error: '候选文件不可读取（可能已被系统临时目录回收），请重新生成',
        });
        continue;
      }
      if (!img.overwrite) {
        try {
          await fs.access(img.outputPath);
          errors.push({
            id: img.id,
            outputPath: img.outputPath,
            error: '目标文件已存在且未允许覆盖',
          });
          continue;
        } catch {
          // 不存在——正常路径；TOCTOU 由 commitOne 的排他创建兜底
        }
      }
      ready.push(img);
    }

    for (const img of ready) {
      signal?.throwIfAborted();
      try {
        await this.commitOne(img);
        committed.push({
          id: img.id,
          outputPath: img.outputPath,
          mimeType: img.mimeType || 'image/png',
          prompt: img.prompt,
          revisedPrompt: img.revisedPrompt,
          userInstruction: img.userInstruction,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        errors.push({
          id: img.id,
          outputPath: img.outputPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 单文件原子、批次部分完成：任一失败不回到 pending，流程结束
    const status: ImageCommitOutcome['status'] =
      committed.length > 0 && errors.length === 0
        ? 'completed'
        : committed.length > 0
          ? 'partial'
          : 'failed';
    if (status === 'completed' || status === 'failed') {
      // 没有后续审核动作的完整终态直接关闭；错误详情已进入 tool result。
      this.imageNodes.delete(nodeId);
    } else {
      node.status = status; // partial 保留成功候选与失败详情供用户核对
    }
    this.host.emitStateChange();
    return { status, committed, errors };
  }

  cancelReview(nodeId: string, _reason?: string): void {
    const node = this.imageNodes.get(nodeId);
    if (!node) return;
    node.status = 'cancelled';
    node.previewDeadline = undefined;
    this.host.emitStateChange();
  }

  getNode(nodeId: string): ImageNodeState | undefined {
    return this.imageNodes.get(nodeId);
  }

  // ─── IPC 动作提交（校验 → resolve → 立即返回，不在 IPC 栈内调 Provider） ───

  submitReviewAction(nodeId: string, action: ImageReviewAction): ActionSubmitResult {
    const node = this.imageNodes.get(nodeId);
    if (!node) return { success: false, error: '图片节点不存在' };

    const pending = this.pendingReviewActions.get(nodeId);
    if (!pending) {
      const error =
        node.status === 'regenerating'
          ? '图片正在重新生成中，请等待完成'
          : node.status === 'committing'
            ? '正在提交图片，无法执行其他操作'
            : '本次审核已结束或没有等待中的审核动作';
      return { success: false, error };
    }

    if (action.type === 'approve') {
      if (node.images.length === 0) {
        return { success: false, error: '没有可提交的图片' };
      }
      // 混合结果允许确认：commit 提交成功候选，并把失败项写入 partial 结果。
      if (node.images.some((img) => img.status === 'generating')) {
        return { success: false, error: '仍有图片正在生成，请等待完成后再确认' };
      }
      if (!node.images.some((img) => img.status === 'completed')) {
        return { success: false, error: '没有生成成功、可提交的图片' };
      }
    } else if (action.type === 'regenerate') {
      if (node.status === 'preview') {
        return { success: false, error: '请先进入编辑，再提交修改' };
      }
      if (!Array.isArray(action.imageIds) || action.imageIds.length === 0) {
        return { success: false, error: '请选择要修改的图片' };
      }
      const known = new Set(node.images.map((img) => img.id));
      const missing = action.imageIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        return { success: false, error: `图片不存在: ${missing.join(', ')}` };
      }
      if (typeof action.instruction !== 'string' || action.instruction.trim() === '') {
        return { success: false, error: '请输入修改指令' };
      }
      if (action.images && action.images.length > 0) {
        for (const image of action.images) {
          if (!image.data || !image.media_type) {
            return { success: false, error: '参考图数据或 MIME 类型为空' };
          }
        }
      }
    }

    if (pending.previewTimer) clearTimeout(pending.previewTimer);
    this.pendingReviewActions.delete(nodeId);
    pending.resolve(action);
    return { success: true };
  }

  /** auto 预览 → 进入编辑：取消倒计时转无限等待；同步状态修改，不经动作循环 */
  enterImageEdit(nodeId: string): ActionSubmitResult {
    const node = this.imageNodes.get(nodeId);
    if (!node) return { success: false, error: '图片节点不存在' };
    const pending = this.pendingReviewActions.get(nodeId);
    if (!pending || node.status !== 'preview') {
      return { success: false, error: '当前不在预览倒计时中' };
    }
    if (pending.previewTimer) {
      clearTimeout(pending.previewTimer);
      pending.previewTimer = undefined;
    }
    node.status = 'pending_approval';
    node.previewDeadline = undefined;
    this.host.emitStateChange();
    return { success: true };
  }

  /** 删除图片（同步）：不创建对应最终文件，deletedCount 计入 tool result */
  deleteImage(nodeId: string, imageId: string): ActionSubmitResult {
    const node = this.imageNodes.get(nodeId);
    if (!node) return { success: false, error: '图片节点不存在' };
    if (node.status !== 'pending_approval') {
      return { success: false, error: '当前状态不允许删除图片' };
    }
    const before = node.images.length;
    node.images = node.images.filter((img) => img.id !== imageId);
    if (node.images.length === before) {
      return { success: false, error: '图片不存在' };
    }
    node.deletedCount = (node.deletedCount ?? 0) + 1;
    this.host.emitStateChange();
    return { success: true };
  }

  /** 切换 Provider/model：只影响该节点后续重生成，不改全局 active provider */
  changeImageModel(nodeId: string, target: ModelTarget): ActionSubmitResult {
    const node = this.imageNodes.get(nodeId);
    if (!node) return { success: false, error: '图片节点不存在' };
    if (node.status !== 'pending_approval') {
      return { success: false, error: '当前状态不允许切换模型' };
    }
    if (!this.imageApplication?.hasTarget(target)) {
      return { success: false, error: `未找到图片模型 "${target.providerId}/${target.modelId}"` };
    }
    node.target = { ...target };
    this.host.emitStateChange();
    return { success: true };
  }

  // ─── 内部实现 ──────────────────────────────────────────

  private mustGetNode(nodeId: string): ImageNodeState {
    const node = this.imageNodes.get(nodeId);
    if (!node) throw new Error(`图片节点 ${nodeId} 不存在`);
    return node;
  }

  /** 候选目录：OS 临时目录，协议零清理，交系统回收 */
  private candidateDir(nodeId: string): string {
    return path.join(pathsService.getTempDir(this.host.id), 'image-review', nodeId);
  }

  /** 候选文件原子替换：同目录临时文件 + rename；version+1 供前端刷新预览 */
  private async writeCandidate(
    node: ImageNodeState,
    item: ImageItem,
    output: ImageApplicationOutput
  ): Promise<void> {
    const mimeType = output.mimeType;
    const ext = MIME_EXT[mimeType] ?? 'png';
    const dir = this.candidateDir(node.id);
    await fs.mkdir(dir, { recursive: true });
    const finalPath = path.join(dir, `${item.id}.${ext}`);
    const tmpPath = path.join(dir, `${item.id}.tmp-${createUuid().slice(0, 8)}`);
    await fs.writeFile(tmpPath, output.bytes);
    await fs.rename(tmpPath, finalPath);
    item.candidatePath = finalPath;
    item.mimeType = mimeType;
    item.version += 1;
  }

  /**
   * 单文件原子提交：目标目录内同文件系统临时文件；
   * overwrite=true → rename 原子替换；overwrite=false → link 排他创建（TOCTOU 安全）。
   */
  private async commitOne(img: ImageItem): Promise<void> {
    const targetDir = path.dirname(img.outputPath);
    await fs.mkdir(targetDir, { recursive: true });
    const buf = await fs.readFile(img.candidatePath!);
    const tmpPath = path.join(
      targetDir,
      `.${path.basename(img.outputPath)}.tmp-${createUuid().slice(0, 8)}`
    );
    await fs.writeFile(tmpPath, buf);
    if (img.overwrite) {
      try {
        await fs.rename(tmpPath, img.outputPath);
      } catch (err) {
        await fs.unlink(tmpPath).catch(() => {}); // 工作区临时文件必须清理（候选零清理只限 OS temp）
        throw err;
      }
    } else {
      try {
        await fs.link(tmpPath, img.outputPath); // 已存在则 EEXIST 失败——排他语义
      } catch (err) {
        await fs.unlink(tmpPath).catch(() => {});
        throw err;
      }
      await fs.unlink(tmpPath).catch(() => {}); // link 已成功，清理源文件；失败不影响提交结果
    }
  }

  /** 改写 prompt 的专用 AI 请求：优化失败降级用原 prompt；取消不是业务失败 */
  private async rewritePrompt(
    original: string,
    instruction: string,
    signal?: AbortSignal
  ): Promise<string> {
    try {
      const logicalStartedAt = Date.now();
      const response = await this.host.getInference().invoke(
        {
          systemPrompt:
            '你是图片 prompt 优化器。根据用户指令修改原始 prompt。只输出新的英文 prompt，不要任何解释。',
          messages: [
            { role: 'user', content: `原始 prompt: ${original}\n修改指令: ${instruction}` },
          ],
          maxTokens: 500,
          model: this.host.currentTarget,
          promptCacheKey: this.host.id,
        },
        {
          requestId: `image-prompt-${createUuid()}`,
          logicalStartedAt,
          signal,
        }
      );
      const textBlock = response.content.find((b: { type: string }) => b.type === 'text') as
        { text?: string } | undefined;
      return textBlock?.text?.trim() || original;
    } catch {
      signal?.throwIfAborted(); // 吞掉 abort 后继续发起新外部调用违反取消域
      return original;
    }
  }

  private failOutstandingReviews(reason: Error): void {
    this.pendingReviewActions.forEach((review) => {
      if (review.previewTimer) clearTimeout(review.previewTimer);
      review.reject(reason);
    });
    this.pendingReviewActions.clear();
  }
}
