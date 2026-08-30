import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * 浏览器环境运行时
 *
 * 消费 ConfigHost 发布的环境/分组/代理快照，并管理浏览器运行观察。
 *
 * 启动器走 piskiepilot：显式 launch → navigateTo → showWindow。
 */

import {
  BrowserEnvironmentRuntimeProjection,
  type BrowserEnvironmentConfigSnapshot,
} from './browser-environment-runtime-projection.js';
import { browserControlPort } from '../core/pilot/index.js';
import { browserLaunchPlanner } from '../core/pilot/launch/index.js';
import type { BrowserLaunchSpec } from '../piskiepilot/browser/core/browser/browser-launch-spec.js';
import type { BrowserEnvironment, BrowserEnvironmentGroup } from '../../shared/types/index.js';
import type { ProxyPoolSnapshot } from '../../shared/types/proxy.js';
import { occupancyRegistry } from '../core/occupancy/index.js';
import { occupancyKey } from '../../shared/types/occupancy.js';
import { resolveBrowserEnvironmentPurpose } from '../../shared/utils/browser-environment.js';

// 手动启动浏览器时的默认起始页：browserleaks 指纹/WebRTC 检测页，
// 一进去即可直观验证该环境的指纹/IP/WebRTC（防关联效果）。
// navigateTo 要求 url 必须匹配 ^https?://，无法用 about:blank。
const START_URL = 'https://browserleaks.com/webrtc';
const LOGIN_TRAIL_SITE_LIMIT = 8;
const COMMON_SECOND_LEVEL_DOMAINS = new Set(['com', 'net', 'org', 'gov', 'edu', 'co', 'ac']);

export class BrowserEnvironmentRuntime {
  private readonly projection = new BrowserEnvironmentRuntimeProjection();
  private proxySnapshot?: ProxyPoolSnapshot;
  private initialized = false;
  /** 运行中的浏览器：environmentId -> browserId */
  private readonly runningBrowsers = new Map<string, string>();

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
  }

  private getProjection(): BrowserEnvironmentRuntimeProjection {
    if (!this.initialized) throw new Error('BrowserEnvironmentRuntime not initialized');
    return this.projection;
  }

  private requireEnvironment(environmentId: string): BrowserEnvironment {
    const environment = this.getProjection().getEnvironment(environmentId);
    if (environment === undefined) throw new Error(`环境不存在: ${environmentId}`);
    return environment;
  }

  exportConfigSnapshot(): BrowserEnvironmentConfigSnapshot {
    return this.getProjection().exportConfigSnapshot();
  }

  publishConfigSnapshot(snapshot: BrowserEnvironmentConfigSnapshot): void {
    this.projection.publishConfigSnapshot(snapshot);
  }

  publishProxySnapshot(snapshot: ProxyPoolSnapshot): void {
    const previous = this.proxySnapshot;
    this.proxySnapshot = structuredClone(snapshot);
    if (!previous) return;

    const before = new Map(
      previous.proxies.map((proxy) => [proxy.id, proxyRuntimeFingerprint(proxy)])
    );
    const after = new Map(
      snapshot.proxies.map((proxy) => [proxy.id, proxyRuntimeFingerprint(proxy)])
    );
    const changed = new Set(
      [...new Set([...before.keys(), ...after.keys()])].filter(
        (id) => before.get(id) !== after.get(id)
      )
    );
    this.projection.markProxyRestartRequired(changed);
  }

  /** 每个环境固定的 browserId（稳定，供 show/close 复用） */
  private browserIdFor(environmentId: string): string {
    return `environment-${environmentId}`;
  }

  async planLaunch(
    environmentId: string,
    browserId: string,
    userDataId: string,
    backgroundMode: boolean,
    signal?: AbortSignal
  ): Promise<BrowserLaunchSpec> {
    const environment = this.getProjection().getEnvironment(environmentId);
    if (!environment) throw new Error(`环境不存在: ${environmentId}`);
    return browserLaunchPlanner.planEnvironment(
      {
        browserId,
        userDataId,
        proxyId: environment.proxyId,
        identityPolicy: environment.identityPolicy,
        backgroundMode,
      },
      { signal }
    );
  }

  /** 将 Agent 新启动的绑定浏览器投影到环境清单；关闭权仍归 BrowserModule。 */
  recordAgentBrowserStarted(
    environmentId: string,
    browserId: string,
    userDataId: string
  ): BrowserEnvironment | undefined {
    return this.getProjection().updateRuntimeEnvironment(environmentId, {
      status: 'running',
      currentBrowserId: browserId,
      restartRequired: false,
      userDataId,
      lastUsedAt: Date.now(),
    });
  }

  /** 只清除仍指向本次实例的投影，避免过期 teardown 覆盖后续启动。 */
  recordAgentBrowserStopped(
    environmentId: string,
    browserId: string
  ): BrowserEnvironment | undefined {
    const environment = this.getProjection().getEnvironment(environmentId);
    if (!environment || environment.currentBrowserId !== browserId) return environment;
    return this.getProjection().updateRuntimeEnvironment(environmentId, {
      status: 'idle',
      currentBrowserId: undefined,
      restartRequired: false,
    });
  }

  // ============================================================
  // 配置投影读取
  // ============================================================

  listEnvironments(): BrowserEnvironment[] {
    return this.getProjection().listEnvironments();
  }

  getEnvironment(id: string): BrowserEnvironment | undefined {
    return this.getProjection().getEnvironment(id);
  }

  resolveBoundEnvironments(
    environmentIds: string[]
  ): Array<{ id: string; name: string; purpose: string }> {
    return environmentIds.map((environmentId) => {
      const environment = this.getProjection().getEnvironment(environmentId);
      if (!environment) throw new Error(`绑定的浏览器环境不存在或已被删除: ${environmentId}`);
      return {
        id: environment.id,
        name: environment.name,
        purpose: resolveBrowserEnvironmentPurpose(environment),
      };
    });
  }

  listGroups(): BrowserEnvironmentGroup[] {
    return this.getProjection().listGroups();
  }

  // ============================================================
  // 浏览器启动 / 停止
  // ============================================================

  async startBrowser(environmentId: string): Promise<BrowserEnvironment> {
    const projection = this.getProjection();
    const environment = projection.getEnvironment(environmentId);
    if (!environment) throw new Error(`环境不存在: ${environmentId}`);

    const browserId = this.browserIdFor(environmentId);
    // 每个环境独立 userDataId（隔离 cookie/storage 目录），首次启动固定下来
    const userDataId = environment.userDataId || environmentId;

    const spec = await this.planLaunch(environmentId, browserId, userDataId, false);
    let launched = false;
    try {
      await browserControlPort.launch(spec);
      launched = true;
      await browserControlPort.navigateTo({
        browserId,
        url: START_URL,
      });
      await browserControlPort.showWindow(browserId);
    } catch (error) {
      if (launched) {
        try {
          await browserControlPort.closeBrowser({ browserId });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Browser launch rollback failed');
        }
      }
      throw error;
    }

    this.runningBrowsers.set(environmentId, browserId);
    const updated = projection.updateRuntimeEnvironment(environmentId, {
      status: 'running',
      currentBrowserId: browserId,
      restartRequired: false,
      userDataId,
      lastUsedAt: Date.now(),
    });
    appLog.info({
      event: 'browser.environment.start.completed',
      message: 'Browser environment started',
      context: {
        scope: 'browser.environment',
        environmentId,
        browserId,
        userDataId,
      },
    });
    return updated!;
  }

  async stopBrowser(environmentId: string): Promise<BrowserEnvironment> {
    const projection = this.getProjection();
    const environment = projection.getEnvironment(environmentId);
    if (!environment) throw new Error(`环境不存在: ${environmentId}`);

    const occupancy = occupancyRegistry.find(
      occupancyKey('browserEnvironment', environment.userDataId ?? environmentId)
    );
    if (occupancy) {
      const { agentService } = await import('./agent.service.js');
      // occupantId === ownerId 即占用者本身是顶层流程；否则精确拆除那个子代理
      if (occupancy.occupantId === occupancy.ownerId) {
        await agentService.stopAgent(occupancy.occupantId);
      } else {
        await agentService.stopSubagent(occupancy.occupantId);
      }

      const afterAgentStop = projection.getEnvironment(environmentId)!;
      if (afterAgentStop.status !== 'running') {
        appLog.info({
          event: 'browser.environment.stop.completed',
          message: 'Browser environment stopped',
          context: {
            scope: 'browser.environment',
            environmentId,
            occupantId: occupancy.occupantId,
          },
        });
        return afterAgentStop;
      }
      // borrowed teardown 不关手动窗口，继续走下方手动 close + status 归零。
    }

    const browserId = environment.currentBrowserId || this.browserIdFor(environmentId);
    let stopError: unknown;
    try {
      await browserControlPort.closeBrowser({ browserId });
    } catch (error) {
      stopError = error;
    } finally {
      this.runningBrowsers.delete(environmentId);
      projection.updateRuntimeEnvironment(environmentId, {
        status: 'idle',
        currentBrowserId: undefined,
        restartRequired: false,
      });
    }
    if (stopError) {
      appLog.warn({
        event: 'browser.environment.stop.degraded',
        message: 'Browser environment stopped with cleanup failure',
        context: { scope: 'browser.environment', environmentId, browserId },
        error: stopError,
      });
    } else {
      appLog.info({
        event: 'browser.environment.stop.completed',
        message: 'Browser environment stopped',
        context: { scope: 'browser.environment', environmentId, browserId },
      });
    }
    return projection.getEnvironment(environmentId)!;
  }

  /** 显示（前置）某环境的浏览器窗口，供手动使用 */
  async revealEnvironmentWindow(environmentId: string): Promise<boolean> {
    const environment = this.requireEnvironment(environmentId);
    return browserControlPort.showWindow(
      environment.currentBrowserId || this.browserIdFor(environmentId)
    );
  }

  async captureLoginTrail(environmentId: string): Promise<Array<{ host: string; jar: number }>> {
    const environment = this.requireEnvironment(environmentId);
    if (environment.status !== 'running' || !environment.currentBrowserId) {
      throw new Error('请先启动该环境');
    }

    const result = await browserControlPort.getAllCookies({
      browserId: environment.currentBrowserId,
    });
    const counts = new Map<string, number>();
    for (const cookie of result.cookies) {
      const host = registrableHost(cookie.domain);
      if (!host) continue;
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([, left], [, right]) => right - left)
      .slice(0, LOGIN_TRAIL_SITE_LIMIT)
      .map(([host, jar]) => ({ host, jar }));
  }

  async destroy(): Promise<void> {
    const failures: unknown[] = [];
    for (const [environmentId, browserId] of [...this.runningBrowsers.entries()]) {
      try {
        await browserControlPort.closeBrowser({ browserId });
        this.projection.updateRuntimeEnvironment(environmentId, {
          status: 'idle',
          currentBrowserId: undefined,
          restartRequired: false,
        });
        this.runningBrowsers.delete(environmentId);
      } catch (error) {
        failures.push(error);
      }
    }
    this.initialized = false;
    this.proxySnapshot = undefined;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'BrowserEnvironmentRuntime failed to close every owned browser'
      );
    }
  }

  lifecycleSnapshot(): { initialized: boolean; runningEnvironmentIds: readonly string[] } {
    return Object.freeze({
      initialized: this.initialized,
      runningEnvironmentIds: Object.freeze([...this.runningBrowsers.keys()]),
    });
  }
}

function registrableHost(rawDomain: unknown): string | null {
  if (typeof rawDomain !== 'string') return null;
  const host = rawDomain.replace(/^\./, '').toLowerCase().trim();
  if (!host || host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host || null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tail = labels[labels.length - 1] ?? '';
  const middle = labels[labels.length - 2] ?? '';
  const keep = tail.length === 2 && COMMON_SECOND_LEVEL_DOMAINS.has(middle) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

function proxyRuntimeFingerprint(proxy: ProxyPoolSnapshot['proxies'][number]): string {
  return JSON.stringify({
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
    enabled: proxy.enabled,
  });
}

export const browserEnvironmentRuntime = new BrowserEnvironmentRuntime();
