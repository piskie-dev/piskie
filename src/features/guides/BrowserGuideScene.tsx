import { Check, Chrome } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ActPill } from '../envstudio/glyphs/ActPill';
import { ForgeFields, type ForgeDraft } from '../envstudio/sheets/ForgeSheet';
import { SheetFrame } from '../envstudio/sheets/SheetShell';
import studio from '../envstudio/studio.module.css';
import { ComposerPreview } from './ComposerPreview';
import { interval, typedText } from './planTimeline';
import type { BusinessFrameProps } from './SceneStage';
import { BROWSER_BINDING_OPEN, BROWSER_BINDING_PICK } from './browserGuideTiming';
import s from './businessScenes.module.css';

const ignoreDemoAction = () => {};

export function BrowserGuideFrame({ phase, time, scrollProgress = 0 }: BusinessFrameProps & { readonly scrollProgress?: number }) {
  const { t } = useTranslation();
  const sheet = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = sheet.current?.querySelector<HTMLElement>(`.${studio.sheetBody}`);
    if (!body) return;
    const scroll = () => { body.scrollTop = (body.scrollHeight - body.clientHeight) * scrollProgress; };
    scroll();
    const resize = new ResizeObserver(scroll);
    resize.observe(body);
    return () => resize.disconnect();
  }, [phase, scrollProgress, t]);
  const name = t('guides.workflows.browser.name');
  const purpose = t('guides.workflows.browser.value2');
  const draft: ForgeDraft = {
    name: phase === 0 ? typedText(name, interval(time, 300, 1700)) : name,
    purpose: phase === 0 ? typedText(purpose, interval(time, 1700, 3000)) : purpose,
    proxyMode: 'none',
    proxyId: '',
    newProxy: { protocol: 'http', host: '', port: '', username: '', password: '' },
    tzMode: 'ip',
    tzValue: '',
    geoMode: 'ip',
    geoLat: '',
    geoLng: '',
    geoAcc: '1000',
    langMode: 'ip',
    langValue: '',
    userAgent: '',
    platform: '',
    cores: '',
  };
  return (
    <div
      className={`${studio.studio} ${s.browser} ${phase < 4 ? s.browserCreation : ''}`}
      data-guide-source={
        phase < 4
          ? 'ForgeSheet/ForgeFields/SheetFrame'
          : phase >= 6
            ? 'WelcomeComposer/BrowserEnvironmentBindingPicker'
            : 'ProgramMonitor'
      }
    >
      {phase < 4 ? (
        <div ref={sheet} className={s.envSheet}>
          <SheetFrame
            title={t('environmentUi.forge.createTitle')}
            onClose={ignoreDemoAction}
            foot={
              <>
                <span
                  style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}
                  className={studio.fieldWarn}
                />
                <ActPill tone="hush" onClick={ignoreDemoAction}>
                  {t('environmentUi.forge.cancelAction')}
                </ActPill>
                <ActPill
                  tone="prime"
                  onClick={ignoreDemoAction}
                  data-demo-target={phase === 3 ? 'true' : undefined}
                >
                  {t('environmentUi.forge.createAction')}
                </ActPill>
              </>
            }
          >
            <ForgeFields
              draft={draft}
              patch={ignoreDemoAction}
              proxies={[]}
              onCopyUA={ignoreDemoAction}
              onGenerateUA={ignoreDemoAction}
            />
          </SheetFrame>
        </div>
      ) : phase < 6 ? (
        <div className={s.monitor}>
          <div className={studio.dossier}>
            <span className={studio.dossierCap}>{t('environmentUi.monitor.standby')}</span>
            <p className={studio.dossierText}>{purpose}</p>
            <div className={studio.trailLine}>
              <span className={studio.trailWord}>
                {t(
                  phase === 4
                    ? 'environmentUi.monitor.loginTrailEmpty'
                    : 'environmentUi.monitor.signedInSites'
                )}
              </span>
              {phase === 5 && (
                <span className={studio.siteChip}>
                  <Chrome size={14} />
                  <span className={studio.siteHost}>example.com</span>
                </span>
              )}
            </div>
          </div>
          <div className={studio.stageOverlay}>
            <span className={studio.overlayLead}>
              <span className={studio.overlayTitle}>
                <span className={studio.overlayName}>{name}</span>
                <span className={studio.overlayState}>{t('environmentUi.monitor.idle')}</span>
              </span>
            </span>
            <span className={studio.overlayOps}>
              <span data-demo-target={phase === 4 ? 'true' : undefined}>
                <ActPill tone="prime">{t('environmentUi.monitor.start')}</ActPill>
              </span>
              <ActPill tone="hush">{t('environmentUi.monitor.edit')}</ActPill>
            </span>
          </div>
          {phase === 4 && time > 4200 && (
            <div className={s.receipt}>
              <Chrome size={15} />
              {t('environmentUi.monitor.running')}
              <ActPill tone="prime">{t('environmentUi.monitor.showWindow')}</ActPill>
            </div>
          )}
          {phase === 5 && (
            <div className={s.receipt}>
              <Check size={14} />
              {t('guides.workflows.browser.success')}
            </div>
          )}
        </div>
      ) : (
        <div className={s.welcomeShot}>
          <ComposerPreview
            value={phase === 6 ? typedText(t('guides.workflows.browser.request'), interval(time, 0, 1100)) : t('guides.workflows.browser.request')}
            browser
            pickingBrowser={(phase === 6 && time >= BROWSER_BINDING_OPEN.result) || (phase === 7 && time < BROWSER_BINDING_PICK.result)}
            selectedBrowser={phase === 7 && time >= BROWSER_BINDING_PICK.result}
          />
        </div>
      )}
    </div>
  );
}
