import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * PlanRepository - 计划文档持久化（plan=计划正文，task=任务清单，两装置分离）
 *
 * 存储布局（全部落盘、销毁不删、resume 可恢复）：
 *   agent-runs/{mainAgentId}/plans/<planId>.md
 *   agent-runs/{mainAgentId}/plans/current.json
 * 每次 create 都是新文件，历史计划永久保留（对齐 cc 的 ~/.claude/plans/<slug>.md 形态）。
 */

import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import type { PlanMeta } from '../../shared/types/index.js';
import { AgentRunPaths } from './agent-run-paths.js';
/**
 * 生成安全的文件名（移除特殊字符）
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '') // 移除非法字符
    .replace(/\s+/g, '-') // 空格转连字符
    .substring(0, 50); // 限制长度
}

interface CurrentPlanPointer {
  currentPlanId: string;
  taskSummary: string;
  createdAt: string;
}

export class PlanRepository {
  private readonly paths: AgentRunPaths;

  constructor(userDataDirectory = app.getPath('userData')) {
    this.paths = new AgentRunPaths(userDataDirectory);
  }

  private getPlansDir(mainAgentId: string): string {
    return this.paths.plansDir(mainAgentId);
  }

  private getDocumentPath(mainAgentId: string, planId: string): string {
    return path.join(this.getPlansDir(mainAgentId), `${planId}.md`);
  }

  private getPointerPath(mainAgentId: string): string {
    return path.join(this.getPlansDir(mainAgentId), 'current.json');
  }

  /**
   * planId = slug（taskSummary 派生，兜底 untitled）；已存在则追加 -2/-3 去重
   */
  private async allocatePlanId(
    mainAgentId: string,
    taskSummary: string
  ): Promise<string> {
    const slug = sanitizeFilename(taskSummary) || 'untitled';
    let planId = slug;
    for (let n = 2; ; n++) {
      try {
        await fs.access(this.getDocumentPath(mainAgentId, planId));
        planId = `${slug}-${n}`;
      } catch {
        return planId;
      }
    }
  }

  /**
   * 创建计划：正文落盘新文件 + 指针切到新计划
   */
  async createPlan(
    mainAgentId: string,
    taskSummary: string,
    planDocument: string
  ): Promise<{ planId: string; documentPath: string }> {
    await fs.mkdir(this.getPlansDir(mainAgentId), { recursive: true });

    const planId = await this.allocatePlanId(mainAgentId, taskSummary);
    const documentPath = this.getDocumentPath(mainAgentId, planId);
    await fs.writeFile(documentPath, planDocument, 'utf-8');

    await this.saveCurrentPlanPointer(mainAgentId, {
      currentPlanId: planId,
      taskSummary,
      createdAt: new Date().toISOString(),
    });

    return { planId, documentPath };
  }

  /**
   * 读取当前计划元信息（经 current.json 指针；正文文件缺失返回 null）
   */
  async readCurrentPlan(mainAgentId: string): Promise<PlanMeta | null> {
    const pointer = await this.loadCurrentPlanPointer(mainAgentId);
    if (!pointer) return null;

    const documentPath = this.getDocumentPath(mainAgentId, pointer.currentPlanId);
    try {
      await fs.access(documentPath);
    } catch {
      appLog.warn({
        event: 'agent_run.plan.read.degraded',
        message: 'Current plan document was missing',
        context: {
          scope: 'agent_run.plan',
          mainAgentId,
          planId: pointer.currentPlanId,
          reason: 'document_missing',
        },
      });
      return null;
    }

    return {
      planId: pointer.currentPlanId,
      taskSummary: pointer.taskSummary,
      documentPath,
      createdAt: pointer.createdAt,
    };
  }

  /**
   * 读取当前计划正文内容（供前端"查看计划"弹窗）
   */
  async readCurrentPlanDocument(
    mainAgentId: string
  ): Promise<{ meta: PlanMeta; content: string } | null> {
    const meta = await this.readCurrentPlan(mainAgentId);
    if (!meta) return null;
    try {
      const content = await fs.readFile(meta.documentPath, 'utf-8');
      return { meta, content };
    } catch (error) {
      appLog.error({
        event: 'agent_run.plan.read.failed',
        message: 'Current plan document read failed',
        context: { scope: 'agent_run.plan', mainAgentId, planId: meta.planId },
        error,
      });
      return null;
    }
  }

  /**
   * 写当前计划指针（current.json）
   */
  private async saveCurrentPlanPointer(
    mainAgentId: string,
    pointer: CurrentPlanPointer
  ): Promise<void> {
    const pointerPath = this.getPointerPath(mainAgentId);
    await fs.mkdir(path.dirname(pointerPath), { recursive: true });
    await fs.writeFile(pointerPath, JSON.stringify(pointer, null, 2), 'utf-8');
  }

  /**
   * 读当前计划指针；无文件/损坏返回 null
   */
  private async loadCurrentPlanPointer(
    mainAgentId: string
  ): Promise<CurrentPlanPointer | null> {
    try {
      const content = await fs.readFile(this.getPointerPath(mainAgentId), 'utf-8');
      const pointer = JSON.parse(content) as CurrentPlanPointer;
      return pointer?.currentPlanId ? pointer : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        appLog.error({
          event: 'agent_run.plan_pointer.read.failed',
          message: 'Current plan pointer read failed',
          context: { scope: 'agent_run.plan_pointer', mainAgentId },
          error,
        });
      }
      return null;
    }
  }
}

export const planRepository = new PlanRepository();
