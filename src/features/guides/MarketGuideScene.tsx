import { Check, ChevronDown, PlugZap, Puzzle, Search, ShieldAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MarketEntry } from '../../../shared/types/market';
import CapabilityListItem from '../../pages/Market/CapabilityListItem';
import market from '../../pages/Market/market.module.css';
import mcp from '../../pages/Market/mcp-config-editor.module.css';
import task from '../../components/task-definition/taskDefinitionModal.module.css';
import { interval, typedText } from './planTimeline';
import type { BusinessFrameProps } from './SceneStage';
import { ComposerPreview } from './ComposerPreview';
import s from './businessScenes.module.css';

const noop = () => {};

export function ExtensionsGuideFrame({ phase, time }: BusinessFrameProps) {
  const { t } = useTranslation();
  const name = t('guides.workflows.extensions.name');
  const description = t('guides.workflows.extensions.description');
  const entry: MarketEntry = {
    id: 'guide-docs',
    kind: 'skill',
    name,
    description,
    sourceId: 'guide',
    sourceName: 'piskie-docs',
    sourceUrl: '',
    installSource: '',
    installed: phase >= 2,
  };
  return (
    <div
      className={s.market}
      data-guide-source={
        phase === 1
          ? 'InstallScopeDialog'
          : phase === 3
            ? 'WelcomeComposer'
            : 'Market/CapabilityListItem'
      }
    >
      {phase === 3 ? (
        <div className={s.welcomeShot}>
          <ComposerPreview
            workspace
            value={typedText(t('guides.workflows.extensions.request'), interval(time, 500, 2500))}
          />
        </div>
      ) : phase === 1 ? (
        <div className={`${market.dialogSheet} ${s.installSheet}`}>
          <header className={market.dialogHeader}>
            <div>
              <h2>{t('marketUi.install.installNamed', { name })}</h2>
              <p>{t('marketUi.install.fromSource', { source: entry.sourceName })}</p>
            </div>
            <X size={15} />
          </header>
          <p className={market.dialogDescription}>{description}</p>
          <div className={market.trustNote}>
            <ShieldAlert size={15} />
            <span>{t('marketUi.install.unreviewedSourceNotice')}</span>
          </div>
          <div className={market.scopeList}>
            <span className={market.scopeListTitle}>{t('marketUi.install.locationTitle')}</span>
            <div className={market.scopeRow}>
              <span className={market.scopeIndicator} />
              <span className={market.scopeCopy}>
                <strong>{t('marketUi.location.global')}</strong>
                <span>{t('marketUi.install.globalDescription')}</span>
              </span>
            </div>
            <div className={`${market.scopeRow} ${market.scopeRowSelected}`}>
              <span className={market.scopeIndicator} />
              <span className={market.scopeCopy}>
                <strong>{t('marketUi.install.specificProjects')}</strong>
                <span>{t('marketUi.install.selectedProjectsOnly')}</span>
              </span>
            </div>
            <div className={`${market.projectRow} ${market.projectRowSelected}`}>
              <span className={market.projectIndicator}>
                <Check size={12} />
              </span>
              <span className={market.projectCopy}>
                <strong>{t('guides.examples.workspace')}</strong>
                <small>/projects/piskie-docs</small>
              </span>
            </div>
          </div>
          <footer className={market.dialogFooter}>
            <div className={market.footerActions}>
              <span className={market.secondaryButton}>{t('common.cancel')}</span>
              <span className={market.primaryButton} data-demo-target="true">
                {t('marketUi.install.installToProjects', { count: 1 })}
              </span>
            </div>
          </footer>
        </div>
      ) : (
        <>
          <div className={market.toolbar}>
            <nav className={market.viewTabs}>
              {['marketTab', 'installedTab', 'updatesTab'].map((key, i) => (
                <span
                  key={key}
                  className={`${market.viewTab} ${i === (phase === 0 ? 0 : 1) ? market.viewTabActive : ''}`}
                >
                  {t(`marketUi.page.${key}`)}
                </span>
              ))}
            </nav>
          </div>
          <div className={s.marketBody}>
            <div className={market.searchBox}>
              <Search size={14} />
              <span>{phase === 0 ? typedText(name, interval(time, 300, 2000)) : name}</span>
            </div>
            <div className={market.filterRow}>
              <span className={`${market.filterChip} ${market.filterChipActive}`}>
                {t('marketUi.filters.skills')}
              </span>
              <span className={market.filterChip}>{t('marketUi.filters.plugins')}</span>
            </div>
            <div data-demo-target="true">
              <CapabilityListItem
                entry={entry}
                selected
                busy={false}
                onSelect={noop}
                onInstall={noop}
                onManage={noop}
              />
            </div>
            {phase === 2 && (
              <section className={market.section}>
                <h3 className={market.sectionTitle}>{t('marketUi.install.locationTitle')}</h3>
                <div className={market.projectRow}>
                  <Check size={14} />
                  <span className={market.projectCopy}>
                    <strong>{t('guides.examples.workspace')}</strong>
                    <small>/projects/piskie-docs</small>
                  </span>
                </div>
              </section>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function McpGuideFrame({ phase, time }: BusinessFrameProps) {
  const { t } = useTranslation();
  const command = 'npx -y @upstash/context7-mcp';
  if (phase === 0)
    return (
      <div className={s.market} data-guide-source="Market/InstallScopeDialog">
        <div className={`${market.dialogSheet} ${s.installSheet}`}>
          <header className={market.dialogHeader}>
            <h2>{t('marketUi.install.installNamed', { name: t('guides.examples.mcpName') })}</h2>
            <X size={15} />
          </header>
          <div className={market.installList}>
            <span className={market.installListTitle}>{t('marketUi.install.contentsTitle')}</span>
            <ul>
              <li>
                <span>{t('marketUi.install.mcpServerLabel')}</span>
                <code>{command}</code>
              </li>
            </ul>
          </div>
          <div className={market.trustNote}>
            <ShieldAlert size={14} />
            <span>{t('marketUi.install.unreviewedSourceNotice')}</span>
          </div>
          <div className={market.scopeList}>
            <span className={market.scopeListTitle}>{t('marketUi.install.locationTitle')}</span>
            <div className={`${market.scopeRow} ${market.scopeRowSelected}`}>
              <span className={market.scopeIndicator} />
              <span className={market.scopeCopy}>
                <strong>{t('marketUi.location.global')}</strong>
                <span>{t('marketUi.install.globalDescription')}</span>
              </span>
            </div>
          </div>
          <div className={`${market.riskRow} ${time > 3000 ? market.riskRowSelected : ''}`}>
            <span className={market.projectIndicator}>{time > 3000 && <Check size={12} />}</span>
            <span>{t('marketUi.install.executableConsent')}</span>
          </div>
          <footer className={market.dialogFooter}>
            <div className={market.footerActions}>
              <span className={market.secondaryButton}>{t('common.cancel')}</span>
              <span className={market.primaryButton} data-demo-target="true">
                {t('marketUi.install.installGlobally')}
              </span>
            </div>
          </footer>
        </div>
      </div>
    );
  return (
    <div
      className={s.market}
      data-guide-source={
        phase < 2
          ? 'Market/McpConfigForm'
          : phase === 2
            ? 'Market/McpLiveStatusSection'
            : 'LoadoutRail'
      }
    >
      <div className={market.detailHeader}>
        <span className={market.detailGlyph}>
          <PlugZap size={22} />
        </span>
        <div className={market.detailIdentity}>
          <h2>{t('guides.examples.mcpName')}</h2>
          <span className={market.detailOrigin}>MCP</span>
        </div>
      </div>
      {phase < 2 ? (
        <div className={mcp.form}>
          <div className={mcp.transportChoice}>
            <button type="button" className={mcp.transportActive}>
              {t('marketUi.mcpConfig.localCommand')}
            </button>
            <button type="button">{t('marketUi.mcpConfig.remoteAddress')}</button>
          </div>
          <label className={mcp.field}>
            <span>{t('marketUi.mcpConfig.command')}</span>
            <input readOnly tabIndex={-1} value="npx" />
          </label>
          <label className={mcp.field}>
            <span>
              {t('marketUi.mcpConfig.arguments')}
              <small>{t('marketUi.mcpConfig.onePerLine')}</small>
            </span>
            <textarea
              readOnly
              tabIndex={-1}
              value={
                phase === 0
                  ? typedText('-y\n@upstash/context7-mcp', interval(time, 500, 2500))
                  : '-y\n@upstash/context7-mcp'
              }
            />
          </label>
          <div className={mcp.field}>
            <span>{t('marketUi.mcpConfig.environmentVariables')}</span>
            <div className={mcp.pairEditor}>
              <div className={mcp.pairRow}>
                <input readOnly tabIndex={-1} value="CONTEXT7_API_KEY" />
                <div className={mcp.pairValueCell}>
                  <input readOnly tabIndex={-1} value="****************" />
                </div>
                <X size={12} />
              </div>
            </div>
          </div>
          <div className={market.footerActions}>
            <span className={market.secondaryButton}>{t('common.cancel')}</span>
            <span className={market.primaryButton} data-demo-target="true">
              {t('common.save')}
            </span>
          </div>
        </div>
      ) : phase === 2 ? (
        <section className={market.mcpRuntimeSection}>
          <div className={market.mcpProbeReceipt} data-status="passed">
            <span className={market.mcpProbeIcon}>
              <Check size={14} />
            </span>
            <span>
              <strong>{t('marketUi.mcpLive.probePassed')}</strong>
              <small>{t('marketUi.mcpLive.probeClosedWithTools', { count: 2 })}</small>
            </span>
          </div>
          <div className={market.mcpProjectGroup}>
            <div className={market.mcpProjectHead}>
              <strong>{t('guides.examples.workspace')}</strong>
            </div>
            <div className={market.mcpSessionRow} data-state={time > 4000 ? 'ready' : 'dormant'}>
              <PlugZap size={14} />
              <span className={market.mcpSessionIdentity}>
                <strong>{t('marketUi.mcpLive.mainOwner')}</strong>
                <small>{t('guides.examples.mcpName')}</small>
              </span>
              <span className={market.mcpSessionState}>
                {t(time > 4000 ? 'marketUi.mcpLive.connected' : 'marketUi.mcpLive.connectOnUse')}
              </span>
            </div>
          </div>
        </section>
      ) : (
        <section className={s.loadoutCrop}>
          <div className={task.railTag}>{t('console.mcpConnections')}</div>
          <div className={task.mcpHead}>
            <span>
              <span className={task.mcpHeadTitle}>{t('console.mcpUseAll')}</span>
              <p className={task.mcpHeadDesc}>{t('console.mcpSelectionOrder')}</p>
            </span>
            <span className={task.toggle} />
          </div>
          <div className={task.hr} />
          <div className={task.mcpRow}>
            <span className={task.order}>1</span>
            <span className={task.mcpHit} data-demo-target="true">
              <span className={task.mcpName}>{t('guides.examples.mcpName')}</span>
              <span className={task.mcpSrc}>{t('marketUi.location.global')}</span>
            </span>
            <ChevronDown size={12} />
          </div>
          <p className={task.noteText}>{t('console.mcpWhitelistSummary', { count: 1 })}</p>
          <Puzzle size={16} />
        </section>
      )}
    </div>
  );
}
