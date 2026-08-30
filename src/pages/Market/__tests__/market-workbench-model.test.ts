import { describe, expect, it } from 'vitest';
import i18n from 'i18next';

import '@/i18n';

import type { MarketEntry, MarketInstalledItem, MarketProjectOption } from '@shared/types/market';

import {
  capabilityLocations as projectCapabilityLocations,
  capabilityScopeSentence as describeCapabilityScope,
  installedActionsFor,
  installedItemMatchesEntry,
  installedQueryForEntry,
  locationActions,
  marketCatalogNotice as catalogNotice,
  marketCatalogSurface,
  marketPagination,
  marketViewFromParam,
} from '../market-workbench-model';

const translate = (key: string, values?: Record<string, string | number>) => (
  i18n.t(key, values ?? {})
);

const marketCatalogNotice = (stale: boolean, warnings: readonly string[]) => (
  catalogNotice(stale, warnings, translate)
);

const capabilityScopeSentence = (
  item: MarketInstalledItem,
  projectLabel?: string,
) => describeCapabilityScope(item, translate, projectLabel);

const capabilityLocations = (
  options: Omit<Parameters<typeof projectCapabilityLocations>[0], 'translate'>,
) => projectCapabilityLocations({ ...options, translate });

function project(
  workspace: string,
  overrides: Partial<MarketProjectOption> = {},
): MarketProjectOption {
  return {
    workspace,
    name: workspace.split('/').filter(Boolean).at(-1) ?? workspace,
    runNames: [],
    lastActiveAt: '2026-08-08T00:00:00.000Z',
    threadCount: 1,
    available: true,
    ...overrides,
  };
}

function installedItem(overrides: Partial<MarketInstalledItem> = {}): MarketInstalledItem {
  return {
    id: 'mcp:user:explicit:context7',
    kind: 'mcp',
    name: 'context7',
    description: 'Documentation MCP',
    scope: 'user',
    origin: 'explicit',
    enabled: true,
    canToggle: true,
    canRemove: true,
    updateAvailable: false,
    ...overrides,
  };
}

describe('market workbench model', () => {
  it('selects the requested top-level view and defaults unknown values to marketplace', () => {
    expect(marketViewFromParam('installed')).toBe('installed');
    expect(marketViewFromParam('updates')).toBe('updates');
    expect(marketViewFromParam('other')).toBe('marketplace');
    expect(marketViewFromParam(null)).toBe('marketplace');
  });

  it('describes explicit previous and next pages without truncating the total', () => {
    expect(marketPagination(1_005, 40, 40)).toEqual({
      pageNumber: 2,
      pageCount: 26,
      rangeStart: 41,
      rangeEnd: 80,
      canPrevious: true,
      canNext: true,
      previousOffset: 0,
      nextOffset: 80,
    });
    expect(marketPagination(0, 0, 0)).toMatchObject({
      pageNumber: 0,
      pageCount: 0,
      rangeStart: 0,
      rangeEnd: 0,
      canPrevious: false,
      canNext: false,
    });
  });

  it('shows a cache banner only when a real source warning exists', () => {
    expect(marketCatalogNotice(true, [])).toBeNull();
    expect(marketCatalogNotice(false, ['MCP Registry 返回重复游标'])).toBe('MCP Registry 返回重复游标');
    expect(marketCatalogNotice(true, ['网络刷新失败'])).toBe(
      '目录未完全刷新，正在使用上次成功缓存。网络刷新失败',
    );
  });

  it('never presents an unfinished or failed first synchronization as an empty catalog', () => {
    expect(marketCatalogSurface({
      initialized: false,
      loading: false,
      refreshing: false,
      visibleCount: 0,
      catalogCount: 0,
      hasFailure: false,
    })).toBe('loading');
    expect(marketCatalogSurface({
      initialized: true,
      loading: false,
      refreshing: true,
      visibleCount: 0,
      catalogCount: 0,
      hasFailure: false,
    })).toBe('syncing');
    expect(marketCatalogSurface({
      initialized: true,
      loading: false,
      refreshing: false,
      visibleCount: 0,
      catalogCount: 0,
      hasFailure: true,
    })).toBe('failure');
    expect(marketCatalogSurface({
      initialized: true,
      loading: false,
      refreshing: false,
      visibleCount: 0,
      catalogCount: 0,
      hasFailure: false,
    })).toBe('empty');
    expect(marketCatalogSurface({
      initialized: true,
      loading: true,
      refreshing: true,
      visibleCount: 12,
      catalogCount: 12,
      hasFailure: false,
    })).toBe('content');
  });

  it('keeps a stale populated cache searchable while it refreshes in the background', () => {
    expect(marketCatalogSurface({
      initialized: true,
      loading: false,
      refreshing: true,
      visibleCount: 0,
      catalogCount: 20_159,
      hasFailure: false,
    })).toBe('empty');
  });

  it('never exposes member-level removal or toggling for plugin-owned capabilities', () => {
    const actions = installedActionsFor(installedItem({
      origin: 'plugin',
      plugin: 'docs-suite',
      canToggle: false,
      canRemove: false,
    }));

    expect(actions).toEqual({
      canUpdate: false,
      canToggle: false,
      canProbe: true,
      canRemove: false,
      manageOwner: true,
    });
  });

  it('offers update only when an installed item still maps to a market entry', () => {
    expect(installedActionsFor(installedItem({ updateAvailable: true })).canUpdate).toBe(false);
    expect(installedActionsFor(installedItem({
      updateAvailable: true,
      marketEntryId: 'registry:mcp:context7',
    })).canUpdate).toBe(true);
  });

  it('finds a locally aliased MCP by Registry package identity', () => {
    const entry: MarketEntry = {
      id: 'registry:mcp:io.github.upstash/context7',
      kind: 'mcp',
      name: 'io.github.upstash/context7',
      description: 'Context7',
      sourceId: 'registry',
      sourceName: 'MCP Registry',
      sourceUrl: 'https://registry.modelcontextprotocol.io',
      installSource: 'https://registry.modelcontextprotocol.io',
      mcpConfig: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@1.0.32'],
      },
    };
    const localAlias = installedItem({
      name: 'context7',
      marketEntryId: entry.id,
      endpoint: 'npx -y @upstash/context7-mcp@1.0.31',
    });

    expect(installedQueryForEntry(entry)).toBe('@upstash/context7-mcp');
    expect(installedItemMatchesEntry(localAlias, entry)).toBe(true);
  });

  it('描述安装位置时不把 workspace 路径塞进句子', () => {
    expect(capabilityScopeSentence(installedItem())).toBe('安装在全局，所有项目共用这一份。');
    expect(capabilityScopeSentence(installedItem({
      scope: 'project',
      workspace: '/workspace/projects/project-a',
    }), 'project-a')).toBe('安装在项目“project-a”中，只有此项目可以使用。');
    expect(capabilityScopeSentence(installedItem({ scope: 'builtin' })))
      .toBe('随应用内置，所有项目都能使用，不能卸载。');
  });

  it('安装位置只包含真实配置，继承关系只为当前项目生成', () => {
    const global = installedItem({
      id: 'mcp:user:explicit:context7',
      endpoint: 'npx -y @upstash/context7-mcp@1.0.32',
    });
    const own = installedItem({
      id: 'mcp:project:explicit:project-a:context7',
      scope: 'project',
      workspace: '/workspace/projects/project-a',
      endpoint: 'npx -y @upstash/context7-mcp@1.0.31',
      enabled: false,
    });

    const rows = capabilityLocations({
      records: [global, own],
      projects: [
        project('/workspace/projects/project-b'),
        project('/workspace/projects/project-a'),
        project('/workspace/projects/unavailable-project', { available: false }),
      ],
    });

    expect(rows.map((row) => [row.label, row.shared, row.enabled])).toEqual([
      ['全局', false, true],
      ['project-a', false, false],
    ]);
    expect(rows[1]).toMatchObject({ endpointDiffers: true });

    const focusedRows = capabilityLocations({
      records: [global, own],
      projects: [
        project('/workspace/projects/project-b'),
        project('/workspace/projects/project-a'),
      ],
      focusWorkspace: '/workspace/projects/project-b',
    });
    expect(focusedRows[2]).toMatchObject({
      label: 'project-b',
      shared: true,
      record: global,
    });
  });

  it('全局配置不会随项目数量制造安装记录', () => {
    const projects = Array.from({ length: 100 }, (_, index) => project(`/repo/project-${index}`));
    expect(capabilityLocations({ records: [installedItem()], projects })).toHaveLength(1);
  });

  it('没有全局副本时，项目之外的位置不虚构共用行', () => {
    const own = installedItem({
      id: 'skill:project:explicit:project-a:writer',
      kind: 'skill',
      name: 'writer',
      scope: 'project',
      workspace: '/workspace/projects/project-a',
      canToggle: false,
    });

    const rows = capabilityLocations({
      records: [own],
      projects: [
        project('/workspace/projects/project-a'),
        project('/workspace/projects/project-b'),
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'project-a', shared: false });
  });

  it('按处开关只给 MCP：技能只有全局那份能开关，插件成员一处都不能', () => {
    const globalMcp = capabilityLocations({
      records: [installedItem()],
      projects: [project('/repo/a')],
      focusWorkspace: '/repo/a',
    });
    expect(locationActions(globalMcp[0]!, 'mcp')).toEqual({
      canToggle: true,
      canConfigure: true,
      canFork: false,
      canRemove: true,
    });
    expect(locationActions(globalMcp[1]!, 'mcp')).toEqual({
      canToggle: true,
      canConfigure: false,
      canFork: true,
      canRemove: false,
    });

    const skill = capabilityLocations({
      records: [installedItem({ kind: 'skill', name: 'writer' })],
      projects: [project('/repo/a')],
      focusWorkspace: '/repo/a',
    });
    expect(locationActions(skill[0]!, 'skill').canToggle).toBe(true);
    expect(locationActions(skill[1]!, 'skill')).toMatchObject({
      canToggle: false,
      canConfigure: false,
      canFork: false,
    });

    const member = capabilityLocations({
      records: [installedItem({ origin: 'plugin', plugin: 'docs-suite', canToggle: false, canRemove: false })],
      projects: [project('/repo/a')],
      focusWorkspace: '/repo/a',
    });
    expect(locationActions(member[0]!, 'mcp')).toMatchObject({ canToggle: false, canRemove: false });
    expect(locationActions(member[1]!, 'mcp')).toMatchObject({ canToggle: false, canFork: false });
  });

});
