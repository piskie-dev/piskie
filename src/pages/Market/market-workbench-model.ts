import type {
  MarketEntry,
  MarketEntryKind,
  MarketInstalledItem,
  MarketProjectOption,
} from '@shared/types/market';
import { projectDisplayName } from '@shared/types/project';

export type MarketView = 'marketplace' | 'installed' | 'updates';

export const MARKET_PAGE_SIZE = 40;

export type MarketCatalogSurface = 'loading' | 'syncing' | 'failure' | 'content' | 'empty';

type MarketTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

export function marketCatalogSurface(options: {
  initialized: boolean;
  loading: boolean;
  refreshing: boolean;
  visibleCount: number;
  catalogCount: number;
  hasFailure: boolean;
}): MarketCatalogSurface {
  if (options.visibleCount > 0) return 'content';
  if (!options.initialized || options.loading) return 'loading';
  if (options.refreshing && options.catalogCount === 0) return 'syncing';
  if (options.hasFailure) return 'failure';
  return 'empty';
}

export function marketViewFromParam(value: string | null): MarketView {
  if (value === 'installed' || value === 'updates') return value;
  return 'marketplace';
}

export function marketPagination(total: number, offset: number, visibleCount: number) {
  const safeTotal = Math.max(0, total);
  const safeOffset = Math.max(0, offset);
  const pageCount = safeTotal > 0 ? Math.ceil(safeTotal / MARKET_PAGE_SIZE) : 0;
  return {
    pageNumber: safeTotal > 0 ? Math.floor(safeOffset / MARKET_PAGE_SIZE) + 1 : 0,
    pageCount,
    rangeStart: safeTotal > 0 ? safeOffset + 1 : 0,
    rangeEnd: Math.min(safeOffset + Math.max(0, visibleCount), safeTotal),
    canPrevious: safeOffset > 0,
    canNext: safeOffset + Math.max(0, visibleCount) < safeTotal,
    previousOffset: Math.max(0, safeOffset - MARKET_PAGE_SIZE),
    nextOffset: safeOffset + MARKET_PAGE_SIZE,
  };
}

export function marketCatalogNotice(
  stale: boolean,
  warnings: readonly string[],
  translate: MarketTranslator,
): string | null {
  const warning = warnings.find((item) => item.trim().length > 0)?.trim();
  if (!warning) return null;
  return stale
    ? translate('marketUi.catalog.staleWarning', { warning })
    : warning;
}

export function installedActionsFor(item: MarketInstalledItem) {
  return {
    canUpdate: item.updateAvailable && Boolean(item.marketEntryId),
    canToggle: item.canToggle,
    canProbe: item.kind === 'mcp',
    canRemove: item.canRemove,
    manageOwner: Boolean(item.plugin),
  };
}

function stripPackageVersion(value: string): string {
  const separator = value.lastIndexOf('@');
  return separator > 0 ? value.slice(0, separator) : value;
}

export function installedQueryForEntry(entry: MarketEntry): string {
  if (entry.kind !== 'mcp' || !entry.mcpConfig) return entry.name;
  if (entry.mcpConfig.url) return entry.mcpConfig.url;
  const command = entry.mcpConfig.command?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (command === 'npx' || command === 'uvx') {
    const packageArgument = entry.mcpConfig.args?.find((argument) => !argument.startsWith('-'));
    if (packageArgument) return stripPackageVersion(packageArgument);
  }
  return entry.name;
}

export function installedItemMatchesEntry(item: MarketInstalledItem, entry: MarketEntry): boolean {
  return item.marketEntryId === entry.id || (item.kind === entry.kind && item.name === entry.name);
}

export function capabilityScopeSentence(
  item: MarketInstalledItem,
  translate: MarketTranslator,
  projectLabel?: string,
): string {
  if (item.scope === 'builtin') {
    return translate('marketUi.detail.builtinScopeSentence');
  }
  if (item.scope === 'project') {
    const project = projectLabel
      || item.workspace?.split(/[\\/]/).filter(Boolean).at(-1)
      || translate('marketUi.detail.unknownProject');
    return translate('marketUi.detail.projectScopeSentence', { project });
  }
  return translate('marketUi.detail.globalScopeSentence');
}

/** 一个能力在某处的配置情况；继承行只用于当前 Project 的上下文操作。 */
export interface CapabilityLocation {
  key: string;
  place: 'builtin' | 'global' | 'project';
  label: string;
  workspace?: string;
  /** 这一处实际用的记录：自己的配置，或当前 Project 继承的全局／内置配置。 */
  record: MarketInstalledItem;
  /** true = 当前 Project 没有独立配置，只继承全局／内置配置。 */
  shared: boolean;
  enabled: boolean;
  endpoint?: string;
  /** 连接方式（命令或地址）与共用的那一份不同 */
  endpointDiffers: boolean;
}

export function capabilityLocations(options: {
  records: readonly MarketInstalledItem[];
  projects: readonly MarketProjectOption[];
  /** 只有明确处于某个 Project 上下文时，才生成一条可“单独配置”的继承行。 */
  focusWorkspace?: string;
  translate: MarketTranslator;
}): CapabilityLocation[] {
  const { records, projects, focusWorkspace, translate } = options;
  const builtinRecord = records.find((record) => record.scope === 'builtin');
  const globalRecord = records.find((record) => record.scope === 'user');
  const sharedRecord = globalRecord ?? builtinRecord;
  const ownByWorkspace = new Map<string, MarketInstalledItem>();
  for (const record of records) {
    if (record.scope === 'project' && record.workspace) ownByWorkspace.set(record.workspace, record);
  }

  const row = (
    place: CapabilityLocation['place'],
    label: string,
    record: MarketInstalledItem,
    shared: boolean,
    workspace?: string,
  ): CapabilityLocation => ({
    key: `${place}:${workspace ?? ''}`,
    place,
    label,
    workspace,
    record,
    shared,
    enabled: record.enabled,
    endpoint: record.endpoint,
    endpointDiffers: !shared
      && place === 'project'
      && Boolean(record.endpoint)
      && Boolean(sharedRecord?.endpoint)
      && record.endpoint !== sharedRecord?.endpoint,
  });

  const fixed: CapabilityLocation[] = [];
  if (builtinRecord) {
    fixed.push(row(
      'builtin',
      translate('marketUi.location.builtin'),
      builtinRecord,
      false,
    ));
  }
  if (globalRecord) {
    fixed.push(row(
      'global',
      translate('marketUi.location.global'),
      globalRecord,
      false,
    ));
  }

  // Installation rows come only from actual project records. A global install must not
  // manufacture one row for every known Project that happens to inherit it.
  const projectRows: CapabilityLocation[] = [];
  for (const [workspace, own] of ownByWorkspace) {
    const project = projects.find((candidate) => candidate.workspace === workspace);
    const label = project
      ? projectDisplayName(project)
      : workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace;
    projectRows.push(row('project', label, own, false, workspace));
  }
  projectRows.sort((left, right) => (
    Number(right.workspace === focusWorkspace) - Number(left.workspace === focusWorkspace)
    || left.label.localeCompare(right.label)
  ));

  const focusedProject = focusWorkspace
    ? projects.find((project) => project.workspace === focusWorkspace)
    : undefined;
  if (focusWorkspace
    && !ownByWorkspace.has(focusWorkspace)
    && sharedRecord
    && focusedProject?.available !== false) {
    const label = focusedProject
      ? projectDisplayName(focusedProject)
      : focusWorkspace.split(/[\\/]/).filter(Boolean).at(-1) ?? focusWorkspace;
    projectRows.push(row('project', label, sharedRecord, true, focusWorkspace));
  }

  return [...fixed, ...projectRows];
}

/**
 * 每一处能做什么。MCP 的配置与开关按处独立，技能只有全局那份能开关，
 * 插件成员一律由插件整包管理。
 */
export function locationActions(row: CapabilityLocation, kind: MarketEntryKind) {
  const explicit = row.record.origin === 'explicit';
  return {
    canToggle: kind === 'mcp'
      ? explicit && (row.place === 'project' || row.record.canToggle)
      : !row.shared && row.place === 'global' && row.record.canToggle,
    canConfigure: kind === 'mcp' && !row.shared && row.place !== 'builtin',
    canFork: kind === 'mcp' && row.shared && explicit,
    canRemove: !row.shared && row.record.canRemove,
  };
}
