/**
 * ConfigHost 浏览器环境配置与运行观察的内存投影。
 */

import { isDeepStrictEqual } from 'node:util';
import type {
  BrowserEnvironment,
  BrowserEnvironmentGroup,
} from '../../shared/types/index.js';

export interface BrowserEnvironmentConfigSnapshot {
  environments: BrowserEnvironment[];
  groups: BrowserEnvironmentGroup[];
}

export class BrowserEnvironmentRuntimeProjection {
  private controlledConfig: BrowserEnvironmentConfigSnapshot = {
    environments: [],
    groups: [],
  };
  private readonly environmentRuntime = new Map<string, Partial<BrowserEnvironment>>();

  listEnvironments(): BrowserEnvironment[] {
    return this.controlledConfig.environments
      .map((environment) => ({ ...environment, ...this.environmentRuntime.get(environment.id), id: environment.id }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getEnvironment(id: string): BrowserEnvironment | undefined {
    return this.listEnvironments().find((environment) => environment.id === id);
  }

  listGroups(): BrowserEnvironmentGroup[] {
    return [...this.controlledConfig.groups]
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  exportConfigSnapshot(): BrowserEnvironmentConfigSnapshot {
    return {
      environments: this.listEnvironments().map((environment) => ({ ...environment })),
      groups: this.listGroups().map((group) => ({ ...group })),
    };
  }

  /** ConfigHost publication bridge; runtime status and probe observations remain overlays. */
  publishConfigSnapshot(snapshot: BrowserEnvironmentConfigSnapshot): void {
    const previous = new Map(this.controlledConfig.environments.map((environment) => [environment.id, environment]));
    for (const environment of snapshot.environments) {
      const current = previous.get(environment.id);
      if (!current || this.getEnvironment(environment.id)?.status !== 'running') continue;
      if (current.proxyId !== environment.proxyId
        || !isDeepStrictEqual(current.identityPolicy, environment.identityPolicy)) {
        this.environmentRuntime.set(environment.id, {
          ...this.environmentRuntime.get(environment.id),
          restartRequired: true,
        });
      }
    }
    this.controlledConfig = structuredClone(snapshot);
    const environmentIds = new Set(snapshot.environments.map((environment) => environment.id));
    for (const id of this.environmentRuntime.keys()) if (!environmentIds.has(id)) this.environmentRuntime.delete(id);
  }

  updateRuntimeEnvironment(
    id: string,
    updates: Partial<BrowserEnvironment>,
  ): BrowserEnvironment | undefined {
    const runtimeFields = new Set([
      'status',
      'currentBrowserId',
      'restartRequired',
      'userDataId',
      'lastUsedAt',
    ]);
    if (Object.keys(updates).some((key) => !runtimeFields.has(key))) {
      throw new Error('browser-profiles is managed by ConfigHost');
    }
    const current = this.getEnvironment(id);
    if (!current) return undefined;
    this.environmentRuntime.set(id, { ...this.environmentRuntime.get(id), ...updates, id });
    return this.getEnvironment(id);
  }

  markProxyRestartRequired(proxyIds: ReadonlySet<string>): void {
    for (const environment of this.listEnvironments()) {
      if (environment.status !== 'running' || !environment.proxyId || !proxyIds.has(environment.proxyId)) continue;
      this.environmentRuntime.set(environment.id, {
        ...this.environmentRuntime.get(environment.id),
        restartRequired: true,
      });
    }
  }
}
