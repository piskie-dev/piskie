import { createUuid } from '@shared/utils/identifiers.js';

import https from 'node:https';
import type { ConfigHost } from '../../config/host/config-host.js';
import {
  applyConfigPatch,
  escapeConfigPointer,
  patchConfigFields,
} from '../../config/host/config-mutations.js';
import { resolveProxyAgent } from '../../core/proxy/proxy-resolver.js';
import type { AppConfigStore } from '../../core/storage/app-config-store.js';
import { getProxyPoolSnapshot } from '../../core/storage/proxy-config-store.js';
import { DEFAULT_SETTINGS } from '../../../shared/constants/index.js';
import type {
  AppSettings,
  ConfigPlan,
  ConfigPlanIdentity,
  ConfigPlanRequest,
  ConfigProbeRequest,
} from '../../../shared/types/index.js';
import type {
  ProxyProfile,
  ProxyProbeResult,
  ProxyPoolSnapshot,
} from '../../../shared/types/proxy.js';
import type {
  ProxyCreateInput,
  ProxyUpdateInput,
} from '../../../shared/electron-contracts/configuration.js';
import { PublicOperationError } from '../public-errors.js';
import {
  projectConfigPlan,
  projectConfigurationRead,
  restoreConfigurationWrite,
} from './configuration-public-view.js';

export class ConfigurationApplication {
  constructor(private readonly dependencies: {
    host: ConfigHost;
    settings: Pick<AppConfigStore, 'getSettings'>;
    developmentFeatures: boolean;
  }) {}

  listDomains() {
    return this.dependencies.host.domains();
  }

  describe(domain: string) {
    return this.dependencies.host.describe(domain);
  }

  async read(domain: string): Promise<unknown> {
    return projectConfigurationRead(domain, await this.dependencies.host.show(domain));
  }

  history(domain: string) {
    return this.dependencies.host.history(domain);
  }

  async plan(domain: string, request: ConfigPlanRequest): Promise<ConfigPlanIdentity> {
    const descriptor = this.dependencies.host.describe(domain);
    const current = await this.dependencies.host.show(domain);
    const hydrated: ConfigPlanRequest = {
      ...request,
      changes: request.changes.map((change) => {
        if (change.op !== 'set') return change;
        const field = descriptor.fields.find((candidate) => candidate.fieldId === change.fieldId);
        if (!field) return change;
        const path = bindConfigPath(field.pathTemplate, change.bindings);
        return {
          ...change,
          value: restoreConfigurationWrite(
            domain,
            change.value,
            valueAtConfigPath(current, path),
          ),
        };
      }),
    };
    const plan = await this.dependencies.host.createPlan(domain, hydrated);
    return { id: plan.id, domain: plan.domain, baseRevision: plan.baseRevision };
  }

  async validate(planId: string) {
    return projectConfigPlan(await this.dependencies.host.validate<ConfigPlan>(planId));
  }

  probe(planId: string, request: ConfigProbeRequest) {
    return this.dependencies.host.probe(planId, request);
  }

  apply(planId: string, expectedRevision: number) {
    return this.dependencies.host.apply(planId, expectedRevision);
  }

  verify(domain: string, expectedRevision?: number) {
    return this.dependencies.host.verify(domain, expectedRevision);
  }

  rollback(domain: string, targetRevision: number) {
    return this.dependencies.host.rollback(domain, targetRevision);
  }

  readSettings(): AppSettings {
    return this.dependencies.settings.getSettings();
  }

  readSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.dependencies.settings.getSettings()[key];
  }

  async writeSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
    await applyConfigPatch(this.dependencies.host, 'app-settings', [{
      op: 'replace',
      path: `/${escapeConfigPointer(key)}`,
      value,
    }]);
  }

  async writeSettings(settings: Partial<AppSettings>): Promise<void> {
    const current = await this.dependencies.host.show<{ revision: number } & AppSettings>(
      'app-settings',
    );
    await applyConfigPatch(
      this.dependencies.host,
      'app-settings',
      Object.entries(settings).map(([key, value]) => ({
        op: 'replace' as const,
        path: `/${escapeConfigPointer(key)}`,
        value,
      })),
      current.revision,
    );
  }

  async resetSettings(): Promise<void> {
    await applyConfigPatch(this.dependencies.host, 'app-settings', [{
      op: 'replace',
      path: '',
      value: DEFAULT_SETTINGS,
    }]);
  }

  developmentFeatures(): boolean {
    return this.dependencies.developmentFeatures;
  }

  readProxyConfig(): ProxyPoolSnapshot {
    return structuredClone(getProxyPoolSnapshot());
  }

  async addProxy(input: ProxyCreateInput): Promise<ProxyProfile> {
    const proxy: ProxyProfile = { ...input, id: createUuid() };
    const { id, ...value } = proxy;
    await applyConfigPatch(this.dependencies.host, 'proxies', [{
      op: 'add',
      path: `/proxies/${escapeConfigPointer(id)}`,
      value,
    }]);
    return structuredClone(proxy);
  }

  async updateProxy(id: string, updates: ProxyUpdateInput): Promise<ProxyProfile> {
    const current = await this.dependencies.host.show<{
      revision: number;
      proxies: Record<string, Record<string, unknown>>;
    }>('proxies');
    if (!current.proxies[id]) throw new PublicOperationError('not-found', 'Proxy was not found');
    const submitted = { ...updates } as Record<string, unknown>;
    if (!updates.password) delete submitted.password;
    const patch = patchConfigFields(
      `/proxies/${escapeConfigPointer(id)}`,
      current.proxies[id],
      submitted,
      new Set(['name', 'protocol', 'host', 'port', 'username', 'password', 'enabled']),
    );
    const result = await applyConfigPatch<typeof current>(
      this.dependencies.host,
      'proxies',
      patch,
      current.revision,
    );
    return structuredClone({ id, ...result.current.proxies[id] } as unknown as ProxyProfile);
  }

  async removeProxy(id: string): Promise<void> {
    if (!getProxyPoolSnapshot().proxies.some((proxy) => proxy.id === id)) {
      throw new PublicOperationError('not-found', 'Proxy was not found');
    }
    await applyConfigPatch(this.dependencies.host, 'proxies', [{
      op: 'remove',
      path: `/proxies/${escapeConfigPointer(id)}`,
    }]);
  }

  async testProxy(id: string, signal: AbortSignal): Promise<ProxyProbeResult> {
    const proxy = getProxyPoolSnapshot().proxies.find((candidate) => candidate.id === id);
    if (!proxy) throw new PublicOperationError('not-found', 'Proxy was not found');
    const proxyAgent = await resolveProxyAgent(proxy);
    const startedAt = Date.now();

    return new Promise<ProxyProbeResult>((resolve) => {
      let settled = false;
      const finish = (result: ProxyProbeResult): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        resolve(result);
      };
      const request = https.get('https://httpbin.org/ip', { agent: proxyAgent }, (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { origin?: unknown };
            finish({
              reachable: true,
              latencyMs: Date.now() - startedAt,
              ...(typeof parsed.origin === 'string' && { externalIp: parsed.origin }),
            });
          } catch {
            finish({ reachable: true, latencyMs: Date.now() - startedAt });
          }
        });
      });
      const abort = (): void => {
        request.destroy();
        finish({ reachable: false, error: 'Cancelled' });
      };
      signal.addEventListener('abort', abort, { once: true });
      request.on('error', (error) => finish({ reachable: false, error: error.message }));
      request.setTimeout(10_000, () => {
        request.destroy();
        finish({ reachable: false, error: 'Connection timeout' });
      });
    });
  }
}

function bindConfigPath(
  template: string,
  bindings: Readonly<Record<string, string | number>> | undefined,
): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = bindings?.[name];
    return value === undefined
      ? `{${name}}`
      : String(value).replaceAll('~', '~0').replaceAll('/', '~1');
  });
}

function valueAtConfigPath(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  let current = root;
  for (const token of pointer.split('/').slice(1)) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      current = current[Number(key)];
      continue;
    }
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
