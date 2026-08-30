import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * BrowserModule — 浏览器控制
 *
 * 负责浏览器模式检测、userData 配置、截图管理、
 * 占用声明与浏览器生命周期。
 *
 * 封装浏览器子流程所需的浏览器生命周期逻辑。
 */

import fs from 'fs/promises';
import path from 'path';
import type { AgentModule } from './module.js';
import type { AgentHost } from '../agent-host.js';
import type { ToolContextBuilder } from '../tool-context.js';
import type { TaskAdvancedSettings } from '../../../shared/types/index.js';
import type { ResolvedBrowserBinding } from './browser-binding.js';
import { occupancyRegistry } from '../../core/occupancy/index.js';
import { browserEnvironmentRuntime } from '../../services/browser-environment-runtime.js';
import { browserLaunchPlanner } from '../../core/pilot/launch/index.js';
import { createUuid } from '@shared/utils/identifiers.js';
import { renderSkillTeachingDoc } from '../../skills/discovery/teaching.js';
import type { SkillCatalogPort } from '../../core/pilot/pilot-manager.js';
import type {
  BrowserScreenshotTarget,
  BrowserHostRuntime,
} from '../../piskiepilot/core/skill/host.js';
import {
  createGeneratedBrowserSkillRuntime,
  type GeneratedBrowserSkillRuntime,
  type GeneratedSkillBrowserBinding,
} from '../../piskiepilot/browser/runtime/generated-skill-browser.js';
import * as browserCore from '../../piskiepilot/browser/skills/browser/index.js';

interface BrowserModuleConfig {
  /** 浏览器模式 */
  mode: 'browser' | 'local';
  /** Skills */
  skills?: string[];
  /** 高级设置 */
  advancedSettings?: TaskAdvancedSettings;
  /** 所属顶层 Agent ID */
  mainAgentId?: string;
  /** 绑定的浏览器环境 ID */
  browserEnvironmentId?: string;
  /** 创建 Worker 时解析并冻结的浏览器资源绑定。 */
  binding?: ResolvedBrowserBinding;
  /** 工作空间路径 */
  workspace?: string;
}

export class BrowserModule implements AgentModule, BrowserHostRuntime {
  readonly name = 'browser';
  readonly domain = 'browser' as const;
  readonly core = browserCore;
  private host!: AgentHost;
  private config!: BrowserModuleConfig;

  /** 浏览器 ID */
  private browserId?: string;
  // ─── 浏览器子流程运行时私有状态 ─────────────────────────
  /** 缓存模式判断结果 */
  private isBrowserMode = false;
  /** navigateTo 成功后才为 true，防止 ScreenPreview 提前订阅 */
  private browserLaunched = false;
  /** false 表示接管手动已打开的浏览器，普通 teardown 只松手不关窗。 */
  private ownsBrowser = false;
  /** 绑定环境只有成功声明占用后才取得关闭权，避免冲突回滚误关当前占用者。 */
  private environmentOccupancyClaimed = false;

  init(host: AgentHost, config: Record<string, unknown>): void {
    this.host = host;
    if (config.mode !== 'browser' && config.mode !== 'local') {
      throw new Error('BrowserModule requires an explicit browser or local mode');
    }
    this.config = config as unknown as BrowserModuleConfig;
  }

  // ─── 生命周期 ──────────────────────────────────────────

  async onStart(): Promise<void> {
    const agentId = this.host.id;
    const skills = this.host.getSkillCatalog();
    const browser = this.host.getBrowserControl();

    // 1. 模式由 Worker 创建合同唯一决定
    this.isBrowserMode = this.config.mode === 'browser';

    // 2. 浏览器相关初始化
    if (this.isBrowserMode) {
      if (!browser || !skills) {
        throw new Error('BrowserModule requires browser and skill catalog ports');
      }
      const binding = this.config.binding;
      if (!binding) {
        throw new Error(`Browser Worker ${agentId} 缺少创建期 Browser Binding`);
      }
      this.browserId = binding.browserId;

      // 2a. 声明占用
      const userDataId = binding.userDataId;
      const ownerId = this.config.mainAgentId ?? agentId;
      // 冲突 = 可诚实报告的失败：拒绝启动，不带病共用环境。
      // ⚓ L2 systemContract：同一环境的第二个子流程在这里被拒。
      // 失败 AgentRun 的占用被保留时（隔离），同 key 的新 claim 在这里被拒而非撞残留 Chrome。
      const environmentClaim = occupancyRegistry.claim({
        kind: 'browserEnvironment',
        resourceId: userDataId,
        occupantId: agentId,
        ownerId,
        occupantName: this.host.spec.name,
      });
      if (!environmentClaim.ok) {
        throw new Error(
          `浏览器环境 ${userDataId} 当前被 ${environmentClaim.heldBy.occupantName} 占用（可能是未完成关闭的任务），请先处理冲突或稍后重试`
        );
      }
      this.environmentOccupancyClaimed = true;
      const instanceClaim = occupancyRegistry.claim({
        kind: 'browserInstance',
        resourceId: this.browserId,
        occupantId: agentId,
        ownerId,
        occupantName: this.host.spec.name,
      });
      if (!instanceClaim.ok) {
        throw new Error(
          `浏览器实例 ${this.browserId} 当前被 ${instanceClaim.heldBy.occupantName} 占用，请先处理冲突或稍后重试`
        );
      }

      // 占用齐全后再做唯一一次 owned/borrowed 判定；失败回滚阶段尚未取得关闭权。
      this.ownsBrowser = !browser.hasBrowser(this.browserId);

      if (this.ownsBrowser) {
        const spec = this.config.browserEnvironmentId
          ? await browserEnvironmentRuntime.planLaunch(
              this.config.browserEnvironmentId,
              this.browserId,
              userDataId,
              true
            )
          : await browserLaunchPlanner.planTask({
              browserId: this.browserId,
              userDataId,
              identity: {
                ...(this.config.advancedSettings?.language
                  ? { language: this.config.advancedSettings.language }
                  : {}),
                ...(this.config.advancedSettings?.userAgent
                  ? { userAgent: this.config.advancedSettings.userAgent }
                  : {}),
              },
              fingerprint: this.config.advancedSettings?.fingerprint,
              backgroundMode: this.config.advancedSettings?.backgroundMode ?? true,
            });
        // owned 才显式启动；borrowed 保持现有 generation。
        await browser.launch(spec);
        if (this.config.browserEnvironmentId) {
          browserEnvironmentRuntime.recordAgentBrowserStarted(
            this.config.browserEnvironmentId,
            this.browserId,
            userDataId
          );
        }
      }

      // 2d. 加载浏览器技能文档并追加到核心文档
      await this.loadSkillDocs(skills);
    }

    // 3. 本地模式 Skill 文档加载（外装技能走教学包渲染器：SKILL.md + skill_call 函数签名）
    if (!this.isBrowserMode && this.config.skills?.length) {
      try {
        if (!skills) throw new Error('BrowserModule requires a skill catalog port');
        const teachingDocs = await this.renderAssignedSkillDocs(skills, this.config.skills);
        if (teachingDocs) {
          this.host.setSkillDocs(this.host.getSkillDocs() + '\n\n' + teachingDocs);
        }
      } catch (error) {
        appLog.warn({
          event: 'agent.skill_docs.load.degraded',
          message: 'Assigned skill documentation loading degraded',
          context: {
            scope: 'agent.skill_docs',
            agentId,
            skillCount: this.config.skills.length,
          },
          error,
        });
        this.host.setSkillDocs(
          this.host.getSkillDocs() + '\n\n[WARNING] 部分技能文档加载失败，工具调用可能受影响'
        );
      }
    }
  }

  /**
   * 边界终止发起：发起浏览器最终 close——一步到位
   * （不是 disconnect→close 两段），经 BrowserManager 生命周期句柄，不排队不等 mutex。
   * close 失败必须成为 rejection——它是 finishDestroy 的边界终止凭据
   * （errors 非空 → 租约保留）。不碰租约（释放唯一归 releaseResources）。
   */
  async onDestroyBegin(): Promise<void> {
    const agentId = this.host.id;
    const browser = this.host.getBrowserControl();
    if (!browser) return;
    if (!this.ownsBrowser) {
      return;
    }
    if (this.config.browserEnvironmentId && !this.environmentOccupancyClaimed) {
      return;
    }

    const browserId = this.getBrowserId();
    const closeStartedAt = Date.now();

    await browser.closeBrowser({ browserId });
    if (this.config.browserEnvironmentId) {
      browserEnvironmentRuntime.recordAgentBrowserStopped(
        this.config.browserEnvironmentId,
        browserId
      );
    }
    const closeElapsedMs = Date.now() - closeStartedAt;

    if (closeElapsedMs >= 1000) {
      appLog.warn({
        event: 'agent.browser.stop.slow',
        message: 'Agent browser stop was slow',
        context: {
          scope: 'agent.browser',
          agentId,
          browserId,
          durationMs: closeElapsedMs,
        },
      });
    }
  }

  /**
   * 模块内存级清理：浏览器关闭已由 onDestroyBegin 发起（不重复汇总
   * 同一 closePromise）；不释放租约（唯一写入点是 AgentRuntime.releaseResources）。
   */
  async onDestroy(): Promise<void> {
    // 清理内部状态
    this.browserId = undefined;
    this.browserLaunched = false;
    this.environmentOccupancyClaimed = false;
  }

  // ─── 工具上下文贡献 ──────────────────────────────────────

  contributeTools(builder: ToolContextBuilder): void {
    builder.addResourceIds({ browserId: this.getBrowserId() }).setBrowser(this);
  }

  // ─── 公共方法 ──────────────────────────────────────────

  getBrowserReady(): boolean {
    return this.isBrowserMode && !!this.browserId && this.browserLaunched;
  }

  markBrowserLaunched(): void {
    if (this.browserLaunched) return;
    this.browserLaunched = true;
    this.host.emitStateChange();
  }

  notifyPageOpen(): void {
    this.markBrowserLaunched();
  }

  createGeneratedRuntime(binding: GeneratedSkillBrowserBinding): GeneratedBrowserSkillRuntime {
    return createGeneratedBrowserSkillRuntime(binding);
  }

  getBrowserId(): string {
    if (this.browserId) return this.browserId;
    const agentId = this.host.id;
    if (!this.isBrowserMode) {
      return `local-${agentId}`;
    }
    return agentId;
  }

  getIsBrowserMode(): boolean {
    return this.isBrowserMode;
  }

  // ─── 私有辅助方法 ──────────────────────────────────────

  /**
   * 加载浏览器技能文档并追加到核心文档
   * browser 等内置直注技能走原文档管道；外装技能走教学包渲染器
   * （SKILL.md + 按 Skill 类型生成的调用入口 + 文件清单，与 load_skill 同一渲染器）
   */
  private async loadSkillDocs(skills: SkillCatalogPort): Promise<void> {
    // browser is granted by the Browser Worker spec, not by the optional
    // Assignment skills list. Always load its operating guide for identities
    // that elect to render browser Skill docs.
    const browserSkills = (this.config.skills ?? []).filter((s) => s !== 'browser');
    const coreDocs = await skills.loadSkillDocs(['core']);
    const teachingDocs = await this.renderAssignedSkillDocs(skills, browserSkills);
    const browserDocs = teachingDocs ? `${coreDocs}\n\n${teachingDocs}` : coreDocs;

    this.host.setSkillDocs(this.host.getSkillDocs() + '\n\n' + browserDocs);
  }

  /**
   * 渲染指派外装技能的教学包（逐技能，加载失败按普通 load-error 跳过）
   */
  private async renderAssignedSkillDocs(
    catalog: SkillCatalogPort,
    skills: string[]
  ): Promise<string> {
    const parts: string[] = [];
    for (const skill of skills) {
      try {
        const teaching = await renderSkillTeachingDoc(catalog, skill, { forPrompt: true });
        if (teaching.found) {
          parts.push(teaching.content);
        } else {
          appLog.warn({
            event: 'agent.skill_docs.load.degraded',
            message: 'Assigned skill documentation loading degraded',
            context: {
              scope: 'agent.skill_docs',
              agentId: this.host.id,
              skillName: skill,
              reason: 'not_found',
            },
          });
        }
      } catch (error) {
        appLog.warn({
          event: 'agent.skill_docs.load.degraded',
          message: 'Assigned skill documentation loading degraded',
          context: {
            scope: 'agent.skill_docs',
            agentId: this.host.id,
            skillName: skill,
            reason: 'render_failed',
          },
          error,
        });
      }
    }
    return parts.join('\n\n');
  }

  /**
   * 准备截图目标路径
   */
  async prepareScreenshot(params: Record<string, unknown>): Promise<BrowserScreenshotTarget> {
    return this.reserveScreenshotFile(params);
  }

  private async reserveScreenshotFile(
    params: Record<string, unknown>
  ): Promise<BrowserScreenshotTarget> {
    const scope = {
      agentId: this.host.id,
      mainAgentId: this.host.mainAgentId,
    };
    const format = (params.format as string) || 'png';
    const identity = { id: createUuid(), timestamp: new Date() };
    const filename = `${identity.timestamp.getTime()}-${identity.id.slice(0, 8)}.${format}`;
    const filePath = path.join(
      this.host.getConversationStore().paths.screenshotsDir(scope.mainAgentId, scope.agentId),
      filename
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // 注入 filePath 到 piskiepilot 参数
    params.filePath = filePath;

    return {
      id: identity.id,
      mainAgentId: scope.mainAgentId,
      agentId: scope.agentId,
      filename,
      filePath,
      timestamp: identity.timestamp,
      size: 0,
      format: format as 'png' | 'jpeg' | 'webp',
    };
  }

  /**
   * 完成截图保存：获取文件大小
   */
  async finalizeScreenshot(metadata: BrowserScreenshotTarget): Promise<void> {
    try {
      const stats = await fs.stat(metadata.filePath);
      metadata.size = stats.size;

      appLog.info({
        event: 'agent.screenshot.persist.completed',
        message: 'Browser screenshot persisted',
        context: {
          scope: 'agent.screenshot',
          screenshotId: metadata.id,
          outputPath: metadata.filePath,
          outputBytes: metadata.size,
          agentId: this.host.id,
          mainAgentId: this.host.mainAgentId,
        },
      });
    } catch (error) {
      appLog.error({
        event: 'agent.screenshot.finalize.failed',
        message: 'Browser screenshot finalization failed',
        context: {
          scope: 'agent.screenshot',
          screenshotId: metadata.id,
          outputPath: metadata.filePath,
          agentId: this.host.id,
        },
        error,
      });
    }
  }

  async cleanupScreenshot(metadata: BrowserScreenshotTarget): Promise<void> {
    await fs.unlink(metadata.filePath).catch(() => {});
  }
}
