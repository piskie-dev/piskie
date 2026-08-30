import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * PiskiePilot Manager
 * 封装进程内 piskiepilot 运行时(local + browser 全嵌入式),
 * 提供统一的浏览器自动化接口。
 */

import { PilotRuntime } from '../../piskiepilot/runtime/pilot-runtime.js';
import type {
  PreparedSkillPublication,
  RuntimeBuiltinSkill,
} from '../../piskiepilot/runtime/pilot-runtime.js';
import {
  createSkillsPort,
  type SkillListFilter,
  type SkillListItem,
  type SkillsPort,
} from '../../skills/ports.js';
import { createInstallPublishHooks } from '../../skills/install/publish.js';
import { globalSkillsRoot } from '../../skills/store/layout.js';
import {
  watchSkillsRegistry,
  type RegistryDiffItem,
  type RegistryWatchHandle,
} from '../../skills/store/watch.js';
import { skillToolName } from '../../piskiepilot/core/skill/define.js';
import type {
  LoadedSkillModule,
  SkillDomain,
  SkillFunctions,
} from '../../piskiepilot/core/skill/define.js';
import { createProcessToolCatalog } from '../../tools/index.js';
import type { ToolCatalog } from '../../tools/catalog.js';
import { BrowserManager } from '../../piskiepilot/browser/core/browser/browser-manager.js';
import {
  BrowserOperations,
  type BrowserCookiesResult,
  type BrowserNavigateRequest,
  type BrowserNavigationResult,
} from '../../piskiepilot/browser/core/browser/browser-operations.js';
import { WindowController } from '../../piskiepilot/browser/core/browser/window-controller.js';
import type {
  BrowserLaunchSpec,
  BrowserLaunchWindowSize,
} from '../../piskiepilot/browser/core/browser/browser-launch-spec.js';
import type { SkillType } from '@shared/types/skill.js';
import type { CallerWindowConfig } from '../../../shared/types/index.js';
import { getUserDataRoot, getBrowsersDir, setPilotRoot } from '../../piskiepilot/paths.js';
import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';

import { stripPromptOmitSections } from '../../skills/discovery/teaching.js';

class PilotRuntimeKernel {
  /** 进程内运行时 - local + browser 技能全部进程内执行 */
  private runtime: PilotRuntime | null = null;
  private toolCatalog: ToolCatalog | null = null;
  private isRuntimeReady: boolean = false;
  private skillDocsCache: Map<string, string> = new Map();
  private callerWindowResolver: () => CallerWindowConfig = () => ({});
  private launchWindowSizeResolver: () => BrowserLaunchWindowSize | undefined = () => undefined;

  /**
   * 初始化进程内运行时(local + browser 全嵌入式)
   */
  async initialize(skills: SkillCatalogPort): Promise<void> {
    if (this.runtime && this.isRuntimeReady) return;

    try {
      // 注入状态根:{userData}/piskiepilot(生产 = ~/.piskie/piskiepilot)
      // 必须早于 PilotRuntime 构造(paths.ts 各 getter 为 lazy,首次读取即定根)
      setPilotRoot(path.join(app.getPath('userData'), 'piskiepilot'));

      this.runtime = new PilotRuntime();
      await this.runtime.initialize();
      this.toolCatalog = createProcessToolCatalog(skills, this.runtime);
      this.runtime.bindToolCatalog(this.toolCatalog);
      this.isRuntimeReady = true;
    } catch (error) {
      if (this.runtime) {
        void this.runtime.dispose().catch(() => undefined);
      }
      this.runtime = null;
      this.toolCatalog = null;
      this.isRuntimeReady = false;
      throw error;
    }
  }

  setCallerWindowResolver(resolver: () => CallerWindowConfig): void {
    this.callerWindowResolver = resolver;
  }

  setBrowserLaunchWindowSizeResolver(resolver: () => BrowserLaunchWindowSize | undefined): void {
    this.launchWindowSizeResolver = resolver;
  }

  private getBrowserLaunchWindowSize(): BrowserLaunchWindowSize | undefined {
    try {
      return this.launchWindowSizeResolver();
    } catch (error) {
      appLog.warn({
        event: 'browser.window_size.resolve.degraded',
        message: 'Browser window size resolution degraded',
        context: { scope: 'browser.window_size' },
        error: error,
      });
      return undefined;
    }
  }

  /** 获取后台启动浏览器时用于保留应用焦点的平台窗口标识。 */
  private getCallerWindowConfig(): CallerWindowConfig {
    try {
      return this.callerWindowResolver();
    } catch (error) {
      appLog.warn({
        event: 'browser.caller_window.resolve.degraded',
        message: 'Browser caller window resolution degraded',
        context: { scope: 'browser.caller_window' },
        error: error,
      });
      return {};
    }
  }

  /**
   * 停止运行时并关闭全部 piskiepilot 拉起的内核浏览器。
   */
  async stop(): Promise<void> {
    this.skillDocsCache.clear();

    if (this.runtime) {
      let failure: unknown;
      try {
        await this.runtime.dispose();
      } catch (error) {
        failure = error;
      } finally {
        this.runtime = null;
        this.toolCatalog = null;
        this.isRuntimeReady = false;
      }
      if (failure) throw failure;
    }
  }

  getToolCatalog(): ToolCatalog {
    this.ensureRuntimeReady();
    if (!this.toolCatalog) throw new Error('Process ToolCatalog is not initialized');
    return this.toolCatalog;
  }

  getDirectSkillToolNames(skillNames: readonly string[]): string[] {
    this.ensureRuntimeReady();
    const selected = new Set(skillNames);
    return this.runtime!.getExecutableSkills()
      .filter((skill) => skill.provenance.entryPoint === 'direct' && selected.has(skill.name))
      .flatMap((skill) => Object.keys(skill.functions).map((fn) => skillToolName(skill.name, fn)));
  }

  async classifySkill(skillName: string): Promise<'standard' | 'disabled' | 'unknown'> {
    const available = this.runtime!.getAvailableSkill(skillName);
    if (available?.mode === 'doc-only') return 'standard';
    const info = this.runtime!.getInstalledSkill(skillName);
    if (!info) return 'unknown';
    if (info.executionType === 'guide-only') return 'standard';
    return info.enabled ? 'unknown' : 'disabled';
  }

  /**
   * 加载 Browser Skill 文档(SKILL.md bundle,进程内直调)
   * 文档与代码同包同版本,缓存仅存活于进程内,无需版本失效检测。
   * @param skills - skill 名称数组，使用 'core' 代表 'browser'
   */
  async loadSkillDocs(skills: string[]): Promise<string> {
    this.ensureReady();

    // 生成缓存键
    const cacheKey = skills.sort().join(',');

    // 使用缓存
    if (this.skillDocsCache.has(cacheKey)) {
      return this.skillDocsCache.get(cacheKey)!;
    }

    const names = skills.map((name) => name.trim() === 'core' ? 'browser' : name.trim());
    const docs = stripPromptOmitSections(await this.runtime!.getSkillDocs(names));
    this.skillDocsCache.set(cacheKey, docs);

    return docs;
  }

  /**
   * 加载单个技能的 SKILL.md 文档（跨 local/browser 查找合并）
   * skill-teaching 渲染器 / load_skill 工具的数据源
   */
  async getSkillDocs(skillName: string): Promise<string> {
    this.ensureRuntimeReady();
    return this.runtime!.getSkillDocs([skillName]);
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.skillDocsCache.clear();
  }

  /**
   * 完整物化本次启动配置，并在返回前显式拉起 Chromium。
   *
   * @param browserId - 浏览器实例 ID（如 'agent1-xiaohongshu'），用于区分不同任务的浏览器
   * @param userDataId - 用户数据 ID（如 'xiaohongshu'），用于共享登录状态。如果不提供，默认使用 browserId
   */
  async launchBrowser(spec: BrowserLaunchSpec): Promise<void> {
    this.ensureReady();
    const { browserId } = spec;
    const windowSize = spec.backgroundMode ? this.getBrowserLaunchWindowSize() : undefined;
    const launchSpec: BrowserLaunchSpec = windowSize
      ? Object.freeze({
          ...spec,
          windowSize: Object.freeze({ ...windowSize }),
        })
      : spec;

    const callerWindow = launchSpec.backgroundMode
      ? this.getCallerWindowConfig()
      : undefined;

    await BrowserManager.getOrCreate(browserId, {
      launchSpec,
      ...(callerWindow && Object.keys(callerWindow).length > 0 ? { callerWindow } : {}),
    });
  }

  /** BrowserManager 生命周期表的只读 ready 判定，供 owned/borrowed 分派。 */
  hasBrowser(browserId: string): boolean {
    return BrowserManager.has(browserId);
  }

  async deleteUserDataById(userDataId: string): Promise<number> {
    return this.deleteManagedBrowserData(
      `browser environment ${userDataId}`,
      (resourceId) => resourceId === userDataId
    );
  }

  private async deleteManagedBrowserData(
    target: string,
    matches: (resourceId: string) => boolean
  ): Promise<number> {
    const deletedCount = await this.deleteUserDataDirectories(target, matches);
    await this.deleteBrowserConfigs(target, matches);
    return deletedCount;
  }

  private async deleteUserDataDirectories(
    target: string,
    matches: (resourceId: string) => boolean
  ): Promise<number> {
    const userDataBaseDir = getUserDataRoot();
    let deletedCount = 0;
    try {
      const entries = await fs.readdir(userDataBaseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !matches(entry.name)) continue;
        const dirPath = path.join(userDataBaseDir, entry.name);
        try {
          await fs.rm(dirPath, { recursive: true, force: true });
          deletedCount += 1;
        } catch (error) {
          appLog.warn({
            event: 'browser.profile.delete.degraded',
            message: 'Browser profile deletion degraded',
            context: { scope: 'browser.profile', target, profileName: entry.name },
            error: error,
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        appLog.warn({
          event: 'browser.profile.discover.degraded',
          message: 'Browser profile discovery degraded',
          context: {
            scope: 'browser.profile',
            target,
            storeKind: 'user_data',
          },
          error: error,
        });
      }
    }
    return deletedCount;
  }

  private async deleteBrowserConfigs(
    target: string,
    matches: (resourceId: string) => boolean
  ): Promise<void> {
    const browsersDir = getBrowsersDir();
    try {
      const browserFiles = await fs.readdir(browsersDir, { withFileTypes: true });
      for (const entry of browserFiles) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const browserId = entry.name.slice(0, -'.json'.length);
        if (!matches(browserId)) continue;
        const filePath = path.join(browsersDir, entry.name);
        try {
          await fs.rm(filePath, { force: true });
        } catch (error) {
          appLog.warn({
            event: 'browser.profile.delete.degraded',
            message: 'Browser profile deletion degraded',
            context: { scope: 'browser.profile', target, profileName: entry.name },
            error: error,
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        appLog.warn({
          event: 'browser.profile.discover.degraded',
          message: 'Browser profile discovery degraded',
          context: { scope: 'browser.profile', target, storeKind: 'browser_config' },
          error: error,
        });
      }
    }
  }

  // ============================================================
  // 窗口控制与截图（进程内直调）
  // ============================================================

  /**
   * 获取浏览器页面单帧快照
   * @param browserId - 浏览器实例 ID
   * @param quality - JPEG 质量
   */
  async getSnapshot(browserId: string, quality = 80): Promise<{ data: string; timestamp: number }> {
    this.ensureReady();
    return BrowserOperations.captureJpeg(browserId, quality);
  }

  /**
   * 显示浏览器窗口
   * @param browserId - 浏览器实例 ID
   * @returns 是否成功
   */
  async showWindow(browserId: string): Promise<boolean> {
    this.ensureReady();

    try {
      const result = await BrowserManager.runExclusive(browserId, async ({ automation }) => {
        await automation.getSelectedPage().bringToFront();
        return WindowController.show(browserId);
      });
      if (!result.success) {
        appLog.error({
          event: 'browser.window.show.failed',
          message: 'Browser window display failed',
          context: {
            scope: 'browser.window',
            browserId: browserId,
            reason: result.reason,
          },
        });
        return false;
      }

      return true;
    } catch (error: unknown) {
      appLog.error({
        event: 'browser.window.show.failed',
        message: 'Browser window display failed',
        context: { scope: 'browser.window', browserId: browserId },
        error,
      });
      return false;
    }
  }

  /**
   * 确保运行时就绪(browser 面直调也依赖 runtime 初始化完成 —
   * BrowserManager 清理/技能加载均在 runtime.initialize 内)
   */
  private ensureReady(): void {
    this.ensureRuntimeReady();
  }

  /**
   * 确保进程内运行时就绪
   */
  private ensureRuntimeReady(): void {
    if (!this.isRuntimeReady || !this.runtime) {
      throw new Error('PilotRuntime is not ready. Call initialize() first.');
    }
  }

  /**
   * 检查运行时是否就绪
   */
  isReady(): boolean {
    return this.isRuntimeReady && this.runtime !== null;
  }

  getLoadedSkillModule(
    skillName: string
  ): LoadedSkillModule<SkillDomain, SkillFunctions> | undefined {
    this.ensureRuntimeReady();
    return this.runtime!.getSkillModule(skillName);
  }

  getSkillResourceRoot(skillName: string): string | undefined {
    this.ensureRuntimeReady();
    return this.runtime!.getSkillResourceRoot(skillName);
  }

  // ============================================================
  // 管理面接线（registry 收敛 + 内存发布原语）
  // ============================================================

  /** 与盘上 registry 收敛（CLI 等外部写者变更后由 watch/直连补发触发） */
  async syncSkillsWithRegistry(): Promise<void> {
    this.ensureRuntimeReady();
    await this.runtime!.syncWithRegistry();
    this.clearCache();
  }

  listBuiltinSkills(): RuntimeBuiltinSkill[] {
    if (!this.isReady()) return [];
    return this.runtime!.listBuiltinSkills();
  }

  prepareStandardSkillPublication(input: {
    skillName: string;
    type: SkillType;
    candidateDir: string;
    targetDir: string;
  }): Promise<PreparedSkillPublication> {
    this.ensureRuntimeReady();
    return this.runtime!.prepareStandardSkillPublication(input);
  }

  prepareExecutableSkillPublication(input: {
    skillName: string;
    domain: SkillType;
    modulePath: string;
    installedDir: string;
  }): Promise<PreparedSkillPublication> {
    this.ensureRuntimeReady();
    return this.runtime!.prepareExecutableSkillPublication(input);
  }
}

export interface SkillCatalogPort {
  getToolCatalog(): ToolCatalog;
  getDirectSkillToolNames(skillNames: readonly string[]): string[];
  classifySkill(skillName: string): Promise<'standard' | 'disabled' | 'unknown'>;
  loadSkillDocs(skills: string[]): Promise<string>;
  getSkillDocs(skillName: string): Promise<string>;
  getSkillResourceRoot(skillName: string): string | undefined;
  getLoadedSkillModule(
    skillName: string
  ): LoadedSkillModule<SkillDomain, SkillFunctions> | undefined;
  /** 管理面三层合并视图（内置<全局<项目级遮蔽；清单渲染与 tool_search 的数据源） */
  listManagedSkills(filter?: SkillListFilter): Promise<SkillListItem[]>;
}

export interface BrowserControlPort {
  hasBrowser(browserId: string): boolean;
  showWindow(browserId: string): Promise<boolean>;
  getSnapshot(browserId: string, quality?: number): Promise<{ data: string; timestamp: number }>;
  launch(spec: BrowserLaunchSpec): Promise<void>;
  deleteUserDataById(userDataId: string): Promise<number>;
  navigateTo(params: BrowserNavigateRequest): Promise<BrowserNavigationResult>;
  closeBrowser(params: Readonly<{ browserId: string }>): Promise<void>;
  getAllCookies(params: Readonly<{
    browserId: string;
    urls?: readonly string[];
  }>): Promise<BrowserCookiesResult>;
}

export interface AgentPilotPorts {
  skills: SkillCatalogPort;
  browser: BrowserControlPort;
}

class DefaultSkillCatalogPort implements SkillCatalogPort {
  constructor(private readonly kernel: PilotRuntimeKernel) {}

  getToolCatalog = () => this.kernel.getToolCatalog();
  getDirectSkillToolNames = (skillNames: readonly string[]) =>
    this.kernel.getDirectSkillToolNames(skillNames);
  classifySkill = (skillName: string) => this.kernel.classifySkill(skillName);
  loadSkillDocs = (skills: string[]) => this.kernel.loadSkillDocs(skills);
  getSkillDocs = (skillName: string) => this.kernel.getSkillDocs(skillName);
  getSkillResourceRoot = (skillName: string) => this.kernel.getSkillResourceRoot(skillName);
  getLoadedSkillModule = (skillName: string) => this.kernel.getLoadedSkillModule(skillName);
  listManagedSkills = (filter?: SkillListFilter) => getAppSkillsPort().list(filter);
}

class DefaultBrowserControlPort implements BrowserControlPort {
  constructor(private readonly kernel: PilotRuntimeKernel) {}

  hasBrowser = (browserId: string) => this.kernel.hasBrowser(browserId);
  showWindow = (browserId: string) => this.kernel.showWindow(browserId);
  getSnapshot = (browserId: string, quality?: number) =>
    this.kernel.getSnapshot(browserId, quality);
  launch = (spec: BrowserLaunchSpec) => this.kernel.launchBrowser(spec);
  deleteUserDataById = (userDataId: string) => this.kernel.deleteUserDataById(userDataId);
  navigateTo = (params: BrowserNavigateRequest) => BrowserOperations.navigate(params);
  closeBrowser = (params: Readonly<{ browserId: string }>) =>
    BrowserOperations.close(params.browserId);
  getAllCookies = (params: Readonly<{ browserId: string; urls?: readonly string[] }>) =>
    BrowserOperations.getAllCookies(params);
}

class PilotRuntimeHost {
  constructor(
    private readonly kernel: PilotRuntimeKernel,
    private readonly skills: SkillCatalogPort
  ) {}

  initialize(): Promise<void> {
    return this.kernel.initialize(this.skills);
  }

  stop(): Promise<void> {
    return this.kernel.stop();
  }

  lifecycleSnapshot(): { ready: boolean; ownedBrowserIds: readonly string[] } {
    return Object.freeze({
      ready: this.kernel.isReady(),
      ownedBrowserIds: BrowserManager.ownedIds(),
    });
  }

  setCallerWindowResolver(resolver: () => CallerWindowConfig): void {
    this.kernel.setCallerWindowResolver(resolver);
  }

  setBrowserLaunchWindowSizeResolver(resolver: () => BrowserLaunchWindowSize | undefined): void {
    this.kernel.setBrowserLaunchWindowSizeResolver(resolver);
  }
}

const kernel = new PilotRuntimeKernel();

// ============================================================
// 技能管理面（SkillsPort + registry watch 胶水）
// ============================================================

let appSkillsPort: SkillsPort | null = null;

/** app 内技能变更后立即收敛内存；文件 watcher 只负责观察外部写者。 */
export async function notifyManagedSkillsChanged(): Promise<void> {
  if (kernel.isReady()) {
    await kernel.syncSkillsWithRegistry().catch((error) => {
      appLog.warn({
        event: 'browser.skill_registry.sync.degraded',
        message: 'Browser skill registry synchronization degraded',
        context: { scope: 'browser.skill_registry' },
        error: error,
      });
    });
  }
}

/** app 级技能管理端口（IPC handler / Browser Skill 发布 / 插件事务共用） */
export function getAppSkillsPort(): SkillsPort {
  if (!appSkillsPort) {
    appSkillsPort = createSkillsPort({
      defaultWorkspaceDir: path.join(app.getPath('userData'), 'workspace'),
      installedBy: 'piskie-app',
      runtime: {
        listBuiltin: () => kernel.listBuiltinSkills(),
        getFunctionSignatures: (name) => {
          if (!kernel.isReady()) return undefined;
          const module = kernel.getLoadedSkillModule(name);
          if (!module) return undefined;
          return Object.keys(module.functions).map((fn) => ({ name: fn }));
        },
        getResourceRoot: (name) =>
          kernel.isReady() ? kernel.getSkillResourceRoot(name) : undefined,
        installHooks: createInstallPublishHooks({
          prepareStandardSkillPublication: (input) => kernel.prepareStandardSkillPublication(input),
          prepareExecutableSkillPublication: (input) =>
            kernel.prepareExecutableSkillPublication(input),
        }),
        onChanged: () => notifyManagedSkillsChanged(),
      },
    });
  }
  return appSkillsPort;
}

/**
 * 监听全局技能 registry（感知 CLI 等外部写者）：
 * 变更 → 运行时收敛 → onDiff 统一投影（调用方接 market:change 事件）。
 */
export async function startSkillsRegistryWatch(
  onDiff: (diff: RegistryDiffItem[]) => void
): Promise<() => void> {
  const registryWatch: RegistryWatchHandle = await watchSkillsRegistry({
    skillsRoot: globalSkillsRoot(),
    onChange: async (_next, diff) => {
      if (kernel.isReady()) {
        try {
          await kernel.syncSkillsWithRegistry();
        } catch (error) {
          appLog.warn({
            event: 'browser.skill_registry.sync.degraded',
            message: 'Browser skill registry synchronization degraded',
            context: { scope: 'browser.skill_registry' },
            error: error,
          });
        }
      }
      onDiff(diff);
    },
    onError: (error) => {
      appLog.warn({
        event: 'browser.skill_registry.watch.degraded',
        message: 'Browser skill registry watch degraded',
        context: { scope: 'browser.skill_registry' },
        error: error,
      });
    },
  });
  return () => {
    registryWatch.close();
  };
}

const skillCatalogPort: SkillCatalogPort = new DefaultSkillCatalogPort(kernel);
export const browserControlPort: BrowserControlPort = new DefaultBrowserControlPort(kernel);
export const pilotRuntimeHost = new PilotRuntimeHost(kernel, skillCatalogPort);
export const agentPilotPorts: AgentPilotPorts = Object.freeze({
  skills: skillCatalogPort,
  browser: browserControlPort,
});
