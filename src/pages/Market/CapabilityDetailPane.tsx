import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  Download,
  ExternalLink,
  FolderGit2,
  Globe2,
  LibraryBig,
  PackageCheck,
  PlugZap,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

import type {
  MarketEntry,
  MarketInstalledItem,
  MarketProjectOption,
} from '@shared/types/market';
import type { McpServerConfig } from '@shared/types/mcp';
import type { McpServerInfo } from '@shared/types/mcp';

import { CapabilityTag, StatusBadge } from '../../components/shared';
import { Toggle } from '../../components/task-definition/controls';
import { messageText, type PresentationText } from '../../i18n/presentationText';
import { kindGlyph, kindGlyphClass, kindTag } from './kind-visuals';
import {
  capabilityLabels,
  compatibilityLabel,
  compatibilityVariant,
} from './plugin-compatibility';
import McpConfigForm from './McpConfigForm';
import McpLiveStatusSection, { type McpInstallProbeReceipt } from './McpLiveStatusSection';
import {
  capabilityScopeSentence,
  installedActionsFor,
  locationActions,
  type CapabilityLocation,
  type MarketView,
} from './market-workbench-model';
import styles from './market.module.css';

interface CapabilityDetailPaneProps {
  entry: MarketEntry | null;
  installed: MarketInstalledItem | null;
  locations: CapabilityLocation[];
  locationsLoading: boolean;
  stats: { market: number; installed: number; updates: number };
  busy: boolean;
  onInstall: (entry: MarketEntry) => void;
  onProbe: (item: MarketInstalledItem) => void;
  onUpdate: (item: MarketInstalledItem) => void;
  onManageOwner: (item: MarketInstalledItem) => void;
  onConfigureMcp: (location: CapabilityLocation) => void;
  /** 正在就地编辑的那一处，按安装位置行的 key 认领 */
  mcpEditor: { locationKey: string; server: McpServerInfo; registryName?: string } | null;
  savingMcp: boolean;
  onSaveMcpConfig: (config: McpServerConfig) => Promise<boolean>;
  onCancelMcpEdit: () => void;
  onToggleLocation: (location: CapabilityLocation, enabled: boolean) => void;
  onRemoveLocation: (location: CapabilityLocation) => void;
  onForkLocation: (location: CapabilityLocation) => void;
  onInstallElsewhere: (item: MarketInstalledItem) => void;
  onSelectMember: (item: MarketInstalledItem, member: { kind: 'skill' | 'mcp'; name: string }) => void;
  onNavigateView: (view: MarketView) => void;
  projectLabel?: string;
  projects: MarketProjectOption[];
  mcpProbe?: McpInstallProbeReceipt;
  focusWorkspace?: string;
  /** 瞬时提示条(页面级,替代 antd message) */
  onFlash: (text: PresentationText) => void;
}

type DetailTranslator = (key: string, values?: Record<string, string | number>) => string;

const contentLabel = (entry: MarketEntry, translate: DetailTranslator): string => {
  if (entry.kind === 'mcp') return translate('marketUi.detail.contentMcp');
  if (entry.kind === 'plugin') {
    return entry.executable
      ? translate('marketUi.detail.contentExecutable')
      : translate('marketUi.detail.contentPluginBundle');
  }
  return entry.executable
    ? translate('marketUi.detail.contentExecutable')
    : translate('marketUi.detail.contentDocumentation');
};

const mcpCommands = (entry: MarketEntry): string[] => {
  if (entry.kind === 'mcp' && entry.mcpConfig) {
    return [entry.mcpConfig.url ?? [entry.mcpConfig.command, ...(entry.mcpConfig.args ?? [])].filter(Boolean).join(' ')];
  }
  return entry.members?.mcpServers.map((server) =>
    server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' '),
  ) ?? [];
};

/** 来源地址：http(s) 直接打开，本地路径复制到剪贴板。 */
const SourceLink: React.FC<{
  url: string;
  onFlash: (text: PresentationText) => void;
}> = ({ url, onFlash }) => {
  const { t } = useTranslation();
  const isWebUrl = /^https?:\/\//.test(url);
  return (
    <button
      type="button"
      className={styles.sourceLink}
      title={isWebUrl
        ? t('marketUi.detail.openSourcePage')
        : t('marketUi.detail.copySourcePath')}
      onClick={() => {
        if (isWebUrl) {
          void window.piskie.desktop.system.openExternal(url);
        } else {
          void navigator.clipboard.writeText(url).then(() => (
            onFlash(messageText('marketUi.detail.sourcePathCopied'))
          ));
        }
      }}
    >
      <ExternalLink aria-hidden />
      <code>{url}</code>
    </button>
  );
};

const EmptyDetail: React.FC<{
  stats: CapabilityDetailPaneProps['stats'];
  onNavigateView: (view: MarketView) => void;
}> = ({ stats, onNavigateView }) => {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;

  return (
  <div className={styles.emptyDetail}>
    <LibraryBig aria-hidden />
    <strong>{t('marketUi.detail.emptyTitle')}</strong>
    <p>{t('marketUi.detail.emptyDescription')}</p>
    <div className={styles.quickLinks}>
      <button type="button" className={styles.quickLink} onClick={() => onNavigateView('marketplace')}>
        <Sparkles aria-hidden />
        {t('marketUi.detail.browseMarketCount', { count: stats.market.toLocaleString(locale) })}
      </button>
      <button type="button" className={styles.quickLink} onClick={() => onNavigateView('installed')}>
        <PackageCheck aria-hidden />
        {t('marketUi.detail.installedCount', { count: stats.installed.toLocaleString(locale) })}
      </button>
      {stats.updates > 0 && (
        <button type="button" className={styles.quickLink} onClick={() => onNavigateView('updates')}>
          <RefreshCw aria-hidden />
          {t('marketUi.detail.updateCount', { count: stats.updates.toLocaleString(locale) })}
        </button>
      )}
    </div>
  </div>
  );
};

const originLabel = (item: MarketInstalledItem, translate: DetailTranslator): string => {
  if (item.origin === 'builtin') return translate('marketUi.detail.originBuiltin');
  if (item.origin === 'plugin') {
    return translate('marketUi.detail.originPlugin', { plugin: item.plugin ?? '' });
  }
  return translate('marketUi.detail.originMarket');
};

const placeGlyph = (place: CapabilityLocation['place']) => {
  if (place === 'global') return <Globe2 aria-hidden />;
  if (place === 'builtin') return <PackageCheck aria-hidden />;
  return <FolderGit2 aria-hidden />;
};

const PROJECT_LOCATION_PREVIEW = 3;

const LocationSection: React.FC<Pick<
  CapabilityDetailPaneProps,
  'busy' | 'locations' | 'locationsLoading' | 'onToggleLocation' | 'onRemoveLocation' | 'onForkLocation'
  | 'onInstallElsewhere' | 'onConfigureMcp' | 'mcpEditor' | 'savingMcp' | 'onSaveMcpConfig' | 'onCancelMcpEdit'
  | 'focusWorkspace'
> & { installed: MarketInstalledItem }> = ({
  installed,
  locations,
  locationsLoading,
  busy,
  onToggleLocation,
  onRemoveLocation,
  onForkLocation,
  onInstallElsewhere,
  onConfigureMcp,
  mcpEditor,
  savingMcp,
  onSaveMcpConfig,
  onCancelMcpEdit,
  focusWorkspace,
}) => {
  const { t } = useTranslation();
  const [projectLocationsOpen, setProjectLocationsOpen] = useState(false);
  const explicit = locations.filter((location) => !location.shared);
  const universal = explicit.filter((location) => location.place !== 'project');
  const projects = explicit.filter((location) => location.place === 'project');
  const listedProjects = projectLocationsOpen
    ? projects
    : projects.slice(0, PROJECT_LOCATION_PREVIEW);
  const listed = [...universal, ...listedProjects];
  const focusedInherited = focusWorkspace
    ? locations.find((location) => location.shared && location.workspace === focusWorkspace)
    : undefined;
  const focusedActions = focusedInherited
    ? locationActions(focusedInherited, installed.kind)
    : undefined;
  const showFocusedProject = Boolean(focusedInherited && focusedActions?.canFork);
  const hasUniversalLocation = universal.length > 0;

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>
          <span>{t('marketUi.location.sectionTitle')}</span>
        </div>

        {locationsLoading && explicit.length === 0 ? (
          <p className={styles.locationNote}>{t('marketUi.location.loading')}</p>
        ) : listed.length > 0 ? (
          <div
            className={styles.locationList}
            data-expanded={projectLocationsOpen ? 'true' : undefined}
          >
            {listed.map((location) => {
              const can = locationActions(location, installed.kind);
              const editing = mcpEditor?.locationKey === location.key;
              return (
                <div
                  key={location.key}
                  className={styles.locationRow}
                  data-focused={location.workspace === focusWorkspace ? 'true' : undefined}
                >
                  <div className={styles.locationHead}>
                    <div className={styles.locationMain}>
                      <div className={styles.locationTitle}>
                        {placeGlyph(location.place)}
                        <strong>{location.label}</strong>
                        {!location.enabled && (
                          <StatusBadge variant="warning" dot bordered>
                            {t('marketUi.list.disabled')}
                          </StatusBadge>
                        )}
                      </div>
                      <div className={styles.locationDetail}>
                        {location.workspace && <code>{location.workspace}</code>}
                        {location.endpoint && <span>{location.endpoint}</span>}
                        {location.endpointDiffers && (
                          <em>{t('marketUi.location.endpointDiffers')}</em>
                        )}
                      </div>
                    </div>
                    <div className={styles.locationActions}>
                      {can.canToggle && (
                        <span
                          title={location.place === 'project'
                            ? t('marketUi.location.projectToggleHint', { project: location.label })
                            : t('marketUi.location.globalToggleHint')}
                        >
                          <Toggle
                            on={location.enabled}
                            disabled={busy}
                            ariaLabel={location.enabled
                              ? t('marketUi.location.disableNamedAt', {
                                  name: installed.name,
                                  location: location.label,
                                })
                              : t('marketUi.location.enableNamedAt', {
                                  name: installed.name,
                                  location: location.label,
                                })}
                            onFlip={(enabled) => onToggleLocation(location, enabled)}
                          />
                        </span>
                      )}
                      {can.canConfigure && (
                        <button
                          type="button"
                          className={`${styles.locationButton} ${editing ? styles.locationButtonActive : ''}`}
                          disabled={busy}
                          aria-expanded={editing}
                          onClick={() => (editing ? onCancelMcpEdit() : onConfigureMcp(location))}
                        >
                          {t('marketUi.location.configureAction')}
                        </button>
                      )}
                      {can.canRemove && (
                        <button
                          type="button"
                          className={`${styles.locationButton} ${styles.locationRemove}`}
                          disabled={busy}
                          onClick={() => onRemoveLocation(location)}
                        >
                          {t('marketUi.location.uninstallAction')}
                        </button>
                      )}
                    </div>
                  </div>
                  {editing && mcpEditor && (
                    <McpConfigForm
                      key={mcpEditor.locationKey}
                      server={mcpEditor.server}
                      saving={savingMcp}
                      registryName={mcpEditor.registryName}
                      onCancel={onCancelMcpEdit}
                      onSave={onSaveMcpConfig}
                    />
                  )}
                </div>
              );
            })}

            {projects.length > PROJECT_LOCATION_PREVIEW && (
              <button
                type="button"
                className={`${styles.locationListToggle} ${projectLocationsOpen ? styles.locationListToggleOpen : ''}`}
                aria-expanded={projectLocationsOpen}
                onClick={() => setProjectLocationsOpen((current) => !current)}
              >
                <ChevronDown aria-hidden />
                {projectLocationsOpen
                  ? t('marketUi.location.collapseProjects')
                  : t('marketUi.location.expandProjects', {
                      count: projects.length - PROJECT_LOCATION_PREVIEW,
                    })}
              </button>
            )}
          </div>
        ) : (
          <p className={styles.locationNote}>{t('marketUi.location.none')}</p>
        )}

        {installed.marketEntryId && !hasUniversalLocation && (
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy}
            onClick={() => onInstallElsewhere(installed)}
          >
            <Download />{t('marketUi.location.addLocation')}
          </button>
        )}
      </section>

      {showFocusedProject && focusedInherited && (
        <section className={styles.section}>
          <div className={styles.sectionTitle}><span>{t('marketUi.location.currentProject')}</span></div>
          <div className={styles.currentProjectRow}>
            <FolderGit2 aria-hidden />
            <span className={styles.currentProjectCopy}>
              <strong>{focusedInherited.label}</strong>
              <small>{t('marketUi.location.inheritsGlobal')}</small>
              {focusedInherited.workspace && <code>{focusedInherited.workspace}</code>}
            </span>
            {!focusedInherited.enabled && (
              <StatusBadge variant="warning" dot bordered>{t('marketUi.list.disabled')}</StatusBadge>
            )}
            <button
              type="button"
              className={styles.locationButton}
              disabled={busy}
              title={t('marketUi.location.forkHint')}
              onClick={() => onForkLocation(focusedInherited)}
            >
              {t('marketUi.location.forkAction')}
            </button>
          </div>
        </section>
      )}
    </>
  );
};

const CapabilityDetail: React.FC<Omit<
  CapabilityDetailPaneProps,
  'stats' | 'onNavigateView'
>> = ({
  entry,
  installed,
  locations,
  locationsLoading,
  busy,
  onInstall,
  onProbe,
  onUpdate,
  onManageOwner,
  onConfigureMcp,
  onToggleLocation,
  onRemoveLocation,
  onForkLocation,
  onInstallElsewhere,
  onSelectMember,
  projectLabel,
  mcpEditor,
  savingMcp,
  onSaveMcpConfig,
  onCancelMcpEdit,
  projects,
  mcpProbe,
  focusWorkspace,
  onFlash,
}) => {
  const { t, i18n } = useTranslation();
  const anchor = installed ?? entry;
  if (!anchor) return null;

  const version = installed?.version ?? entry?.version;
  const actions = installed ? installedActionsFor(installed) : null;
  const byPlugin = installed?.origin === 'plugin';
  const alreadyInstalled = Boolean(installed) || Boolean(entry?.installed);
  const executable = installed ? installed.executionType === 'executable' : entry?.executable;
  const members = installed?.members ?? entry?.members;
  const compatibility = installed?.compatibility ?? entry?.compatibility;
  const adapterWarnings = installed?.warnings ?? entry?.warnings ?? [];
  const showsLocations = Boolean(installed) && !byPlugin;
  // 安装位置表已按处列出各自的连接方式，这里不再重复一份目录里的
  const commands = showsLocations
    ? []
    : installed?.endpoint ? [installed.endpoint] : entry ? mcpCommands(entry) : [];
  const sourceUrl = entry?.sourceUrl ?? (installed && installed.kind !== 'mcp' ? installed.source : undefined);
  const showActionBar = Boolean((!alreadyInstalled && entry) || actions?.canUpdate || actions?.canProbe);

  const compatibilityStatus = compatibility ? compatibilityLabel(compatibility, t) : null;
  const locale = i18n.resolvedLanguage ?? i18n.language;

  const facts: Array<{ label: string; value: string }> = [
    {
      label: t('marketUi.detail.sourceFact'),
      value: installed
        ? originLabel(installed, t)
        : entry?.sourceName ?? t('marketUi.detail.unknownValue'),
    },
    {
      label: t('marketUi.detail.versionFact'),
      value: version ?? t('marketUi.detail.unversioned'),
    },
  ];
  if (entry) {
    facts.push({ label: t('marketUi.detail.contentFact'), value: contentLabel(entry, t) });
  }
  if (installed) {
    facts.push({
      label: t('marketUi.detail.updateFact'),
      value: installed.updateAvailable
        ? t('marketUi.detail.newVersion', { version: installed.availableVersion ?? '' })
        : t('marketUi.detail.upToDate'),
    });
  } else if (entry?.projectedTokens) {
    facts.push({
      label: t('marketUi.detail.contextUsageFact'),
      value: t('marketUi.detail.approximateTokens', {
        count: entry.projectedTokens.toLocaleString(locale),
      }),
    });
  }

  return (
    <article className={styles.detailArticle}>
      <header className={styles.detailHeader}>
        <span className={`${styles.detailGlyph} ${kindGlyphClass(anchor.kind)}`}>{kindGlyph(anchor.kind)}</span>
        <div className={styles.detailIdentity}>
          <h2>{anchor.name}</h2>
          {byPlugin && installed && (
            <span className={styles.detailOrigin}>
              {capabilityScopeSentence(installed, t, projectLabel)}
            </span>
          )}
          <p className={styles.detailDescription}>
            {anchor.description || t('marketUi.list.noDescription')}
          </p>
          <div className={styles.detailBadges}>
            <CapabilityTag type={kindTag(anchor.kind, executable)} />
            {installed ? (
              <StatusBadge variant={installed.enabled ? 'success' : 'warning'} dot bordered>
                {installed.enabled ? t('marketUi.detail.enabled') : t('marketUi.list.disabled')}
              </StatusBadge>
            ) : entry?.installed ? (
              <StatusBadge variant="success" dot bordered>{t('marketUi.list.installed')}</StatusBadge>
            ) : null}
            {version && <StatusBadge bordered>v{version}</StatusBadge>}
            {entry?.maturity === 'curated' && (
              <StatusBadge variant="success" bordered>{t('marketUi.detail.curated')}</StatusBadge>
            )}
            {entry?.maturity === 'experimental' && (
              <StatusBadge variant="warning" bordered>{t('marketUi.detail.experimental')}</StatusBadge>
            )}
            {entry?.license && <StatusBadge bordered>{entry.license}</StatusBadge>}
            {compatibility && compatibilityStatus && (
              <StatusBadge variant={compatibilityVariant(compatibility)} bordered>
                {compatibilityStatus}
              </StatusBadge>
            )}
          </div>
        </div>
      </header>

      {showActionBar && (
        <div className={styles.actionBar}>
          {!alreadyInstalled && entry && (
            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy || entry.installable === false}
              title={entry.installable === false ? entry.installDisabledReason : undefined}
              onClick={() => onInstall(entry)}
            >
              <Download />
              {entry.installable === false
                ? t('marketUi.detail.cannotInstall')
                : t('marketUi.list.installAction')}
            </button>
          )}
          {installed && actions?.canUpdate && (
            <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => onUpdate(installed)}>
              <RefreshCw />
              {t('marketUi.detail.updateToVersion', { version: installed.availableVersion ?? '' })}
            </button>
          )}
          {installed && actions?.canProbe && (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={busy || !installed.enabled}
              title={installed.enabled
                ? t('marketUi.detail.probeHint')
                : t('marketUi.detail.enableBeforeProbe')}
              onClick={() => onProbe(installed)}
            >
              {t('marketUi.detail.runProbe')}
            </button>
          )}
        </div>
      )}

      {compatibility && compatibilityStatus && anchor.kind === 'plugin' && (
        <div className={styles.compatibilityLine} data-status={compatibility.status}>
          <strong>{compatibilityStatus}</strong>
          <span>
            {compatibility.reason
              ?? (compatibility.supported.length > 0
                ? t('marketUi.detail.installSupportedMembers', {
                    members: capabilityLabels(compatibility.supported, t),
                  })
                : t('marketUi.detail.noPortableMembers'))}
          </span>
          {compatibility.unsupported.length > 0 && (
            <small>
              {t('marketUi.detail.skipUnsupportedMembers', {
                members: capabilityLabels(compatibility.unsupported, t),
              })}
            </small>
          )}
        </div>
      )}

      {anchor.kind === 'plugin' && adapterWarnings.length > 0 && (
        <div className={styles.adapterWarningLine}>
          <AlertTriangle aria-hidden />
          <span>{adapterWarnings[0]}</span>
          {adapterWarnings.length > 1 && (
            <small>
              {t('marketUi.detail.moreInstallWarnings', { count: adapterWarnings.length - 1 })}
            </small>
          )}
        </div>
      )}

      {installed && actions?.manageOwner && installed.plugin && (
        <div className={styles.banner}>
          <Boxes aria-hidden />
          <div className={styles.bannerBody}>
            <strong>{t('marketUi.detail.installedWithPlugin', { plugin: installed.plugin })}</strong>
            <span>{t('marketUi.detail.pluginMemberRestriction')}</span>
          </div>
          <button type="button" className={styles.bannerAction} onClick={() => onManageOwner(installed)}>
            {t('marketUi.detail.viewPlugin')}
          </button>
        </div>
      )}

      {installed && showsLocations && (
        <LocationSection
          installed={installed}
          locations={locations}
          locationsLoading={locationsLoading}
          busy={busy}
          onToggleLocation={onToggleLocation}
          onRemoveLocation={onRemoveLocation}
          onForkLocation={onForkLocation}
          onInstallElsewhere={onInstallElsewhere}
          onConfigureMcp={onConfigureMcp}
          mcpEditor={mcpEditor}
          savingMcp={savingMcp}
          onSaveMcpConfig={onSaveMcpConfig}
          onCancelMcpEdit={onCancelMcpEdit}
          focusWorkspace={focusWorkspace}
        />
      )}

      {installed?.kind === 'mcp' && (
        <McpLiveStatusSection
          serverName={installed.name}
          locations={locations}
          projects={projects}
          probe={mcpProbe}
        />
      )}

      <section className={styles.section}>
        <div className={styles.sectionTitle}><span>{t('marketUi.detail.basicInfo')}</span></div>
        <div className={styles.factGrid}>
          {facts.map((fact) => (
            <div key={fact.label}><span>{fact.label}</span><strong>{fact.value}</strong></div>
          ))}
        </div>
        {installed && installed.kind !== 'mcp' && installed.source && (
          <div className={styles.pathRow}>
            <span>{t('marketUi.detail.installPath')}</span><code>{installed.source}</code>
          </div>
        )}
      </section>

      {members && (
        <section className={styles.section}>
          <div className={styles.sectionTitle}>
            <span>
              {installed
                ? t('marketUi.detail.includedCapabilities')
                : t('marketUi.detail.willInclude')}
            </span>
            <small>
              {installed
                ? t('marketUi.detail.memberNavigationHint')
                : t('marketUi.detail.memberCounts', {
                    skills: members.skills.length,
                    mcp: members.mcpServers.length,
                  })}
            </small>
          </div>
          <div className={styles.memberList}>
            {members.skills.map((skill) => (
              <button
                type="button"
                className={styles.memberRow}
                key={`skill:${skill.name}`}
                disabled={!installed}
                onClick={() => installed && onSelectMember(installed, { kind: 'skill', name: skill.name })}
              >
                <Sparkles aria-hidden />
                <strong>{skill.name}</strong>
                <small>
                  {skill.executionType === 'executable'
                    ? t('marketUi.detail.executableSkill')
                    : t('marketUi.detail.knowledgeSkill')}
                </small>
              </button>
            ))}
            {members.mcpServers.map((server) => (
              <button
                type="button"
                className={styles.memberRow}
                key={`mcp:${server.name}`}
                disabled={!installed}
                onClick={() => installed && onSelectMember(installed, { kind: 'mcp', name: server.name })}
              >
                <PlugZap aria-hidden />
                <strong>{server.name}</strong>
                <small>
                  {server.transport === 'stdio'
                    ? t('marketUi.detail.localLaunch')
                    : t('marketUi.detail.remoteConnection')}
                </small>
              </button>
            ))}
          </div>
        </section>
      )}

      {commands.length > 0 && anchor.kind !== 'skill' && (
        <section className={styles.section}>
          <div className={styles.sectionTitle}>
            <span>{t('marketUi.detail.connectionMethod')}</span>
            {!alreadyInstalled && <small>{t('marketUi.detail.reviewConnection')}</small>}
          </div>
          <div className={styles.commandStack}>
            {commands.map((command) => <code key={command}>{command}</code>)}
          </div>
        </section>
      )}

      {entry?.content && anchor.kind === 'skill' && (
        <section className={styles.section}>
          <div className={styles.sectionTitle}>
            <span>{t('marketUi.detail.skillDocument')}</span>
            {entry.files && entry.files.length > 0 && (
              <small>{t('marketUi.detail.fileCount', { count: entry.files.length })}</small>
            )}
          </div>
          <pre className={styles.skillPreview}>{entry.content}</pre>
        </section>
      )}

      {sourceUrl && <SourceLink url={sourceUrl} onFlash={onFlash} />}
    </article>
  );
};

const CapabilityDetailPane: React.FC<CapabilityDetailPaneProps> = (props) => (
  <section className={styles.detailPane} aria-live="polite">
    {!props.entry && !props.installed ? (
      <EmptyDetail stats={props.stats} onNavigateView={props.onNavigateView} />
    ) : (
      <CapabilityDetail
        entry={props.entry}
        installed={props.installed}
        locations={props.locations}
        locationsLoading={props.locationsLoading}
        busy={props.busy}
        onInstall={props.onInstall}
        onProbe={props.onProbe}
        onUpdate={props.onUpdate}
        onManageOwner={props.onManageOwner}
        onConfigureMcp={props.onConfigureMcp}
        onToggleLocation={props.onToggleLocation}
        onRemoveLocation={props.onRemoveLocation}
        onForkLocation={props.onForkLocation}
        onInstallElsewhere={props.onInstallElsewhere}
        onSelectMember={props.onSelectMember}
        mcpEditor={props.mcpEditor}
        savingMcp={props.savingMcp}
        onSaveMcpConfig={props.onSaveMcpConfig}
        onCancelMcpEdit={props.onCancelMcpEdit}
        projectLabel={props.projectLabel}
        projects={props.projects}
        mcpProbe={props.mcpProbe}
        focusWorkspace={props.focusWorkspace}
        onFlash={props.onFlash}
      />
    )}
  </section>
);

export default CapabilityDetailPane;
