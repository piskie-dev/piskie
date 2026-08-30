/**
 * DirectorRole — 协调者角色
 * 内联 padding 管理逻辑。
 */

import type { AgentRole, RoleDefaults, RuntimeOptions, LoopConfig } from './role.js';
import type { AgentHost } from '../agent-host.js';
import type { ToolContextBuilder } from '../tool-context.js';
import type { PromptContext } from '../prompts/types.js';
import {
  buildSkillInventory,
  emptySkillInventory,
  resolveContextWindow,
  type SkillInventoryResult,
} from '../../core/pilot/skill-inventory.js';
import { pathsService } from '../../services/paths.service.js';
import { browserEnvironmentRuntime } from '../../services/browser-environment-runtime.js';
export class DirectorRole implements AgentRole {
  /** <available_skills> 清单快照（onStart 时构建，会话中不刷新；resume 重建即重新快照） */
  private skillInventory: SkillInventoryResult = emptySkillInventory();

  getDefaults(options: RuntimeOptions): RoleDefaults {
    return {
      approvalMode: options.initialApprovalMode || 'confirm',
      mainAgentId: null,
    };
  }

  async onStart(host: AgentHost, options: RuntimeOptions): Promise<void> {
    const runConfig = options.runConfig!;

    // 确保工作空间目录
    const workspace = runConfig.workspace;
    if (workspace) {
      await pathsService.ensureWorkspace(workspace);
    }

    // 原生工具直接由模型工具定义教学；这里只构建可安装 Skill 清单。
    const skills = host.getSkillCatalog();
    if (skills) {
      this.skillInventory = await buildSkillInventory(skills, {
        contextWindowTokens: resolveContextWindow(host),
        workspace,
        defaultWorkspaceDir: pathsService.getDefaultWorkspaceDir(),
      });
    }

    // Resume 场景：上下文已由 replay 重建，跳过初始任务注入
    if (options.isResume) return;

    // 添加初始任务（支持多模态）
    const initialImages = options.images;
    const initialTaskText = runConfig.promptTemplate || (initialImages?.length ? '(图片)' : '');
    if (initialTaskText || (initialImages && initialImages.length > 0)) {
      host.addUserMessage({
        text: initialTaskText,
        images: initialImages,
        subtype: 'system_task',
      });
    }

  }

  onAfterInterrupt(host: AgentHost): void {
    const store = host.getConversationStore();
    // 中断不销毁 Worker；保存运行时快照供下次恢复识别已失效的旧 Worker。
    store.writeHeader(host.mainAgentId, host.buildHeader());
    host.emitStateChange();
  }

  configureLoop(): LoopConfig {
    return {
      executeMode: 'sequential',
    };
  }

  enrichPromptContext(ctx: PromptContext, host: AgentHost, options: RuntimeOptions): void {
    const runConfig = options.runConfig!;
    ctx.role = 'director';
    ctx.runName = runConfig.name;
    ctx.workspaceDir = runConfig.workspace || pathsService.getDefaultWorkspaceDir();
    ctx.tempDir = pathsService.getTempDir(host.id);
    if (this.skillInventory.count > 0) {
      ctx.availableSkillsBlock = this.skillInventory.text;
    }

    // <user_instructions> 槽位：本次 AgentRun 的用户自定义指令
    if (runConfig.systemPrompt) {
      ctx.userInstructions = runConfig.systemPrompt;
    }

    // L3 模式上下文（渲染在 assemble() 的 modeFragment 里做）
    const modeModule = host.getModule('plan') as { getMode(): string | undefined } | undefined;
    const currentMode = modeModule?.getMode() || options.initialModeId;
    if (currentMode) {
      ctx.modeId = currentMode;
      ctx.approvalMode = host.approvalMode;
    }

    const metadata = runConfig.bindings;
    if (metadata?.type === 'standard' && metadata.boundEnvironmentIds?.length) {
      ctx.boundEnvironments = browserEnvironmentRuntime.resolveBoundEnvironments(
        metadata.boundEnvironmentIds
      );
    }
  }

  enrichToolContext(builder: ToolContextBuilder, host: AgentHost, options: RuntimeOptions): void {
    builder.setAgentInfo({
      agentId: host.id,
      agentSpec: host.spec.name,
      role: 'director',
      mainAgentId: host.id,
      runConfig: options.runConfig,
    });
    builder.setSkillInventory(this.skillInventory.snapshot);
  }

  buildModuleConfig(
    host: AgentHost,
    options: RuntimeOptions
  ): Record<string, Record<string, unknown>> {
    const runConfig = options.runConfig!;
    return {
      subagent: {
        runConfig,
        allocateAgentId: options.allocateAgentId,
        createRuntimeObserver: options.createRuntimeObserver,
        inference: host.getInference(),
        pilotPorts: {
          skills: host.getSkillCatalog(),
          browser: host.getBrowserControl(),
        },
        imageApplication: options.imageApplication,
        imageTarget: options.imageTarget,
      },
      plan: {
        defaultModeId: options.initialModeId || 'normal',
        mainAgentId: host.id,
      },
      image: {
        mode: 'async',
        imageApplication: options.imageApplication,
        imageTarget: options.imageTarget,
      },
    };
  }
}
