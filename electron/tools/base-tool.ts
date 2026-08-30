/**
 * BaseTool - 工具抽象基类
 */

import type { ToolArtifact } from '../../shared/types/index.js';
import type {
  ITool,
  ToolContext,
  ToolDef,
  ToolOutput,
  ToolSuspension,
} from './types.js';
export abstract class BaseTool<TParams = Record<string, unknown>, TData = unknown>
implements ITool<TParams, TData> {
  abstract readonly def: ToolDef<TParams>;

  abstract execute(
    params: TParams,
    context: ToolContext,
  ): Promise<ToolOutput<TData> | ToolSuspension>;

  /**
   * 创建成功结果。artifacts 是持久 UI 产物：由工具显式挑选，
   * 未提供时省略字段，不序列化无意义的 undefined。
   */
  protected success(text: string, data?: TData, artifacts?: ToolArtifact[]): ToolOutput<TData> {
    return { ok: true, text, data, ...(artifacts?.length ? { artifacts } : {}) };
  }

  /**
   * 创建错误结果
   */
  protected error(text: string, data?: TData): ToolOutput<TData> {
    return { ok: false, text, data };
  }

}
