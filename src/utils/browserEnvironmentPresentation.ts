/**
 * 浏览器环境的展示读数：占用登记查询、代理 / 身份策略 / 地理位置的一句话格式。
 * EnvStudio 与会话输入框的浏览器控件共用同一套字段语义。
 */

import type { BrowserEnvironment } from '@shared/types';
import type { ProxyProfile } from '@shared/types/proxy';
import { occupancyKey, type Occupancy } from '@shared/types/occupancy';

export type EnvironmentTranslator = (key: string) => string;

export function browserEnvironmentNameOf(
  environments: readonly Pick<BrowserEnvironment, 'id' | 'name'>[],
  id: string,
): string {
  return environments.find((environment) => environment.id === id)?.name ?? id;
}

/** 运行中环境的占用登记（Agent 占用时环境只读）；登记键是隔离数据目录 ID。 */
export function occupantOf(occupancies: readonly Occupancy[], envId: string): Occupancy | undefined {
  return occupancies.find((item) => item.key === occupancyKey('browserEnvironment', envId));
}

/** 占用登记按 userDataId 落账；老环境没有独立 userDataId 时回退到环境 ID。 */
export function environmentOccupantOf(
  occupancies: readonly Occupancy[],
  environment: Pick<BrowserEnvironment, 'id' | 'userDataId'>,
): Occupancy | undefined {
  return occupantOf(occupancies, environment.userDataId ?? environment.id)
    ?? (environment.userDataId ? occupantOf(occupancies, environment.id) : undefined);
}

/** 代理显示名（Program 事实行用） */
export function proxyLabelOf(
  proxies: readonly ProxyProfile[],
  proxyId: string | undefined,
  translate: EnvironmentTranslator,
): string {
  if (!proxyId) return translate('environmentUi.identity.directConnection');
  const proxy = proxies.find((item) => item.id === proxyId);
  return proxy
    ? `${proxy.name} · ${proxy.protocol.toUpperCase()}`
    : translate('environmentUi.identity.directConnection');
}

/** 身份策略压成一句话（预监/主屏的 quiet 描述） */
export function identityLineOf(env: BrowserEnvironment, translate: EnvironmentTranslator): string {
  const policy = env.identityPolicy;
  const tz =
    policy.timezone.mode === 'custom'
      ? policy.timezone.value
      : policy.timezone.mode === 'real'
        ? translate('environmentUi.identity.timezoneLocal')
        : translate('environmentUi.identity.timezoneIp');
  const lang = policy.language.mode === 'custom'
    ? policy.language.value
    : translate('environmentUi.identity.languageIp');
  const os =
    policy.platform === 'windows'
      ? 'Windows'
      : policy.platform === 'macos'
        ? 'macOS'
        : policy.platform === 'linux'
          ? 'Linux'
          : translate('environmentUi.identity.platformLocal');
  return `${tz} · ${lang} · ${os}`;
}

/** 地理位置策略的一句话读数 */
export function geolocationLineOf(env: BrowserEnvironment, translate: EnvironmentTranslator): string {
  const geolocation = env.identityPolicy.geolocation;
  if (geolocation.mode === 'custom') return `${geolocation.latitude}, ${geolocation.longitude}`;
  if (geolocation.mode === 'off') return translate('sharedUi.browserBinding.session.geolocationOff');
  return translate('sharedUi.browserBinding.session.geolocationIp');
}

export type EnvironmentStatusTone = 'blue' | 'orange' | 'default';

/** 环境状态的标签与色调；“运行中”只表示浏览器进程在跑，不等于被任务占用。 */
export function environmentStatusOf(
  environment: Pick<BrowserEnvironment, 'status'> | undefined,
  translate: EnvironmentTranslator,
): { label: string; tone: EnvironmentStatusTone } {
  if (!environment) return { label: translate('sharedUi.browserBinding.missing'), tone: 'default' };
  if (environment.status === 'running') return { label: translate('sharedUi.browserBinding.running'), tone: 'orange' };
  return { label: translate('sharedUi.browserBinding.idle'), tone: 'blue' };
}

/** 环境当前被谁使用：空闲 / 本会话的某个 Worker / 会话外的占用者。 */
export type EnvironmentUsage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'worker'; readonly workerId: string; readonly label: string }
  | { readonly kind: 'external'; readonly label: string };

/**
 * 占用登记只说明"谁独占了这个目录"；`status === 'running'` 只表示浏览器进程在跑，
 * 不等于被任务使用，所以使用情况只看登记。
 */
export function resolveEnvironmentUsage(
  environment: Pick<BrowserEnvironment, 'id' | 'userDataId'>,
  occupancies: readonly Occupancy[],
  agentId: string | undefined,
  workers: readonly { readonly id: string; readonly subject: string }[],
): EnvironmentUsage {
  const occupancy = environmentOccupantOf(occupancies, environment);
  if (!occupancy) return { kind: 'idle' };
  if (agentId !== undefined && occupancy.ownerId === agentId && occupancy.occupantId !== agentId) {
    const worker = workers.find((item) => item.id === occupancy.occupantId);
    return { kind: 'worker', workerId: occupancy.occupantId, label: worker?.subject || occupancy.occupantName };
  }
  return { kind: 'external', label: occupancy.occupantName };
}
