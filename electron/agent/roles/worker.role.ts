import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * WorkerRole — 工作者角色（浏览器/本地执行器）
 * 从 UnifiedAgent 的 `if (subagentConfig)` 分支提取。
 */

import type { AgentRole, RoleDefaults, RuntimeOptions, LoopConfig, ToolUseInput } from './role.js';
import type { AgentHost } from '../agent-host.js';
import type { ToolContextBuilder } from '../tool-context.js';
import type { PromptContext } from '../prompts/types.js';
import { renderSkillTeachingDoc } from '../../skills/discovery/teaching.js';
import { pathsService } from '../../services/paths.service.js';
import type {
  AgentRunConfig,
  AssignmentTaskBoardSnapshot,
  SubagentNotification,
} from '../../../shared/types/index.js';
import { renderAssignmentInitialMessage } from '../assignment-message.js';

/** Module 访问接口（避免循环依赖） */
interface BrowserControllerLike {
  markBrowserLaunched(): void;
}

export class WorkerRole implements AgentRole {
  getDefaults(options: RuntimeOptions): RoleDefaults {
    return {
      approvalMode: options.initialApprovalMode || 'auto',
      mainAgentId: options.mainAgentId,
    };
  }

  async onStart(host: AgentHost, options: RuntimeOptions): Promise<void> {
    const subConfig = options.subagentConfig!;

    const skills = host.getSkillCatalog();

    // Browser Worker 由 browser 模块注入领域文档；Local Worker 在这里加载外装技能教学包。
    if (skills && !host.getModule('browser')) {
      const CORE_SKILLS = new Set(['browser']);
      const assignedSkills = (subConfig.skills ?? []).filter((s) => !CORE_SKILLS.has(s));
      if (assignedSkills.length) {
        for (const skill of assignedSkills) {
          try {
            const teaching = await renderSkillTeachingDoc(skills, skill, { forPrompt: true });
            if (teaching.found) {
              host.setSkillDocs(host.getSkillDocs() + '\n\n' + teaching.content);
            } else {
              appLog.warn({
                event: 'agent.skill_docs.load.degraded',
                message: 'Assigned skill documentation loading degraded',
                context: {
                  scope: 'agent.skill_docs',
                  agentId: host.id,
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
                agentId: host.id,
                skillName: skill,
                reason: 'render_failed',
              },
              error,
            });
          }
        }
      }
    }

    // 添加初始任务到上下文（resume 时已由 replay 重建，跳过）
    if (!options.isResume) {
      const snapshot = options.assignmentTaskBoardSnapshot as
        AssignmentTaskBoardSnapshot | undefined;
      if (!snapshot) {
        throw new Error('Worker 缺少创建期 Task Board 快照');
      }
      // [提示词锚点] SubagentTool“编写 prompt”说明依赖此处只注入 Assignment，不继承 Parent 对话。
      host.addUserMessage({
        text: renderAssignmentInitialMessage(subConfig, snapshot),
        subtype: 'assignment',
      });
    }
  }

  onAfterInterrupt(host: AgentHost): void {
    host.emitStateChange();
  }

  configureLoop(host: AgentHost): LoopConfig {
    const bcModule = host.getModule('browser') as unknown as BrowserControllerLike | undefined;

    return {
      executeMode: () => (host.approvalMode === 'auto' ? 'parallel' : 'sequential'),

      onAfterExecute: (toolUse: ToolUseInput, result: unknown) => {
        // navigateTo 成功后标记浏览器已启动，前端才开始订阅视频流
        if (toolUse.name === 'browser_navigateTo' && (result as { ok?: boolean })?.ok) {
          bcModule?.markBrowserLaunched();
        }
      },
    };
  }

  enrichPromptContext(ctx: PromptContext, host: AgentHost, options: RuntimeOptions): void {
    const subConfig = options.subagentConfig!;

    ctx.role = 'worker';
    ctx.skills = subConfig.skills as string[];

    ctx.workspaceDir = (options.workspace as string) || pathsService.getDefaultWorkspaceDir();
    ctx.tempDir = pathsService.getTempDir(host.id);
  }

  enrichToolContext(builder: ToolContextBuilder, host: AgentHost, options: RuntimeOptions): void {
    const subConfig = options.subagentConfig!;
    const runConfig = (options.runConfig ?? {
      name: subConfig.subject,
      description: subConfig.subject,
      promptTemplate: subConfig.prompt,
    }) satisfies AgentRunConfig;
    builder.setAgentInfo({
      agentId: host.id,
      agentSpec: host.spec.name,
      role: 'worker',
      mainAgentId: options.mainAgentId,
      runConfig,
      subagentConfig: subConfig,
    });
    // worker 的可见集 = 出生时被授予并注入教学文档的技能（tool_search 互斥基准）
    builder.setSkillInventory({
      renderedAt: new Date().toISOString(),
      entries: Object.fromEntries(
        (subConfig.skills ?? []).map((skill) => [
          skill,
          { tier: 'full' as const, scope: 'user' as const },
        ])
      ),
    });
    builder
      .setAssignmentSnapshot(
        options.assignmentTaskBoardSnapshot as AssignmentTaskBoardSnapshot | undefined
      )
      .setTaskBoard({
        set: (board) => {
          if (!board) return;
          const callback = options.onTaskBoardChange as ((value: typeof board) => void) | undefined;
          callback?.(board);
        },
      })
      .setEvents({
        allowedTargets: () => [options.mainAgentId],
        send: () => false,
        notifyParent: (event: SubagentNotification) => {
          const notify = options.onNotification as
            ((value: SubagentNotification) => boolean) | undefined;
          return notify?.(event) ?? false;
        },
      });
  }

  buildModuleConfig(
    _host: AgentHost,
    options: RuntimeOptions
  ): Record<string, Record<string, unknown>> {
    const subConfig = options.subagentConfig!;
    const config: Record<string, Record<string, unknown>> = {};

    config['browser'] = {
      mode: subConfig.mode,
      skills: subConfig.skills,
      advancedSettings: subConfig.advancedSettings ?? (options as any).advancedSettings,
      browserEnvironmentId: subConfig.browserEnvironmentId,
      binding: options.browserBinding,
      mainAgentId: options.mainAgentId,
      workspace: options.workspace,
    };

    // 通用 Worker 统一注入显式图片执行目标
    config['image'] = {
      imageApplication: options.imageApplication,
      imageTarget: options.imageTarget,
    };

    return config;
  }
}
