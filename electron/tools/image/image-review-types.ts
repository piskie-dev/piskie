/**
 * 生图审核契约：generate_image 工具与 ImageModule 之间的类型化接口。
 * 工具经 ToolContext.imageOps 获取（替代 metadata 服务定位器）；
 * IPC 只提交审核动作，所有耗时操作（生成/重生成/commit）都在工具 Promise 内执行。
 */

import type { ImageNodeState } from '../../../shared/types/index.js';
import type { ModelTarget } from '../../inference/execution/contracts.js';

/** 预检归一化后的单张图片输入 */
export interface ImageGenerationSpecItem {
  prompt: string;
  size?: string;
  /** 归一化后的最终绝对路径 */
  outputPath: string;
  /** 默认 false：目标已存在时在调用 Provider 前失败 */
  overwrite: boolean;
}

/** 审核动作（pendingImageApprovals 语义 = 返回下一条审核动作） */
export type ImageReviewAction =
  | { type: 'approve' }
  | {
      type: 'regenerate';
      imageIds: string[];
      instruction: string;
      target?: ModelTarget;
      /** 用户粘贴的参考图；是否支持由所选模型的真实调用结果决定。 */
      images?: Array<{ data: string; media_type: string }>;
    }
  | { type: 'cancel'; reason?: string };

/** commit 结果（单文件原子、批次部分完成） */
export interface ImageCommitOutcome {
  status: 'completed' | 'partial' | 'failed';
  committed: Array<{
    id: string;
    outputPath: string;
    mimeType: string;
    prompt: string;
    revisedPrompt?: string;
    /** 审核期用户成功应用的修改指令（告知 AI 该图差异来自用户主动干预） */
    userInstruction?: string;
  }>;
  errors: Array<{
    id: string;
    outputPath: string;
    error: string;
  }>;
}

/** ImageModule 暴露给 generate_image 工具的操作面 */
export interface ImageReviewOps {
  /** 是否已配置图片生成供应商（未配置时工具在任何请求前失败） */
  isConfigured(): boolean;
  /** 创建审核节点（status: generating），捕获当前显式 Provider/model */
  createReviewNode(items: ImageGenerationSpecItem[]): ImageNodeState;
  /** 初次并发生成候选（Promise.allSettled，单图失败不取消其他图片） */
  generateInitialCandidates(nodeId: string, signal?: AbortSignal): Promise<void>;
  /** 等待下一条审核动作（auto 首轮 10s preview 自动 approve；confirm/后续无限等待） */
  waitForReviewAction(nodeId: string): Promise<ImageReviewAction>;
  /** 在工具循环内执行重生成：成功原子替换候选，失败保留旧候选只记录错误 */
  regenerate(
    nodeId: string,
    action: Extract<ImageReviewAction, { type: 'regenerate' }>,
    signal?: AbortSignal,
  ): Promise<void>;
  /** 提交全部保留候选到最终 outputPath，返回结构化结果，不回到 pending */
  commit(nodeId: string, signal?: AbortSignal): Promise<ImageCommitOutcome>;
  /** 用户取消：节点结算为 cancelled，不执行任何文件操作 */
  cancelReview(nodeId: string, reason?: string): void;
  /** 读取节点（构建 tool result 用） */
  getNode(nodeId: string): ImageNodeState | undefined;
}
