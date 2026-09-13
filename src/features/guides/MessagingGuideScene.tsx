import { Check, ChevronDown, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CHANNEL_TITLE_KEYS, channelMark, DM_POLICY_KEYS } from '../imdossier/data/channel-facts';
import dossier from '../imdossier/dossier.module.css';
import { interval, typedText } from './planTimeline';
import type { BusinessFrameProps } from './SceneStage';
import s from './businessScenes.module.css';

export function MessagingGuideFrame({ phase, time }: BusinessFrameProps) {
  const { t } = useTranslation();
  const credentialLabels = ['App ID', 'App Secret'];
  const name = t('guides.workflows.messaging.name');
  const selected = time > 4000 || phase > 0;
  const running = phase === 3 || (phase === 2 && time > 4200);
  return (
    <div className={`${dossier.skinVars} ${s.messaging}`} data-guide-source="DossierPane">
      <header className={dossier.dossHead}>
        <span className={`${dossier.seal} ${dossier.sealLg}`}>{channelMark('feishu')}</span>
        <span className={dossier.dossIdent}>
          <div className={dossier.dossTitle}>{phase < 2 ? t('imPlugin.newBot') : name}</div>
          {phase >= 2 && (
            <div className={dossier.dossMeta}>
              <span className={dossier.entryState} data-s={running ? 'running' : 'stopped'}>
                {t(running ? 'imPlugin.connectionState.live' : 'imPlugin.connectionState.offline')}
              </span>
            </div>
          )}
        </span>
        <span className={dossier.headSpring} />
        {phase === 2 && (
          <span className={dossier.btn} data-demo-target="true">
            {t(running ? 'imPlugin.stop' : 'imPlugin.start')}
          </span>
        )}
        <X size={14} />
      </header>
      <div className={dossier.dossBody}>
        {phase === 0 ? (
          <>
            <section className={dossier.slab} data-wide="true">
              <div className={dossier.slabCap}>{t('imPlugin.dossier.chooseChannel')}</div>
              <div className={dossier.chanPickRack}>
                {Object.entries(CHANNEL_TITLE_KEYS).map(([id, key]) => (
                  <div
                    key={id}
                    className={dossier.chanPick}
                    data-on={id === 'feishu' && selected}
                    data-demo-target={id === 'feishu' || undefined}
                  >
                    <span className={dossier.mark}>{channelMark(id)}</span>
                    <span>{t(key)}</span>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : phase === 1 ? (
          <>
            <section className={dossier.slab}>
              <div className={dossier.slabCap}>{t('imPlugin.botName')}</div>
              <input
                className={dossier.textIn}
                readOnly
                tabIndex={-1}
                value={typedText(name, interval(time, 300, 1400))}
              />
            </section>
            <section className={dossier.slab}>
              <div className={dossier.slabCap}>
                {t('imPlugin.bindTaskDefinition')}
                <Plus size={12} />
              </div>
              <div className={dossier.textIn}>
                {t('guides.workflows.templates.name')}
                <ChevronDown size={12} />
              </div>
            </section>
            <section className={dossier.slab} data-wide="true">
              <div className={dossier.slabCap}>{t('imPlugin.dossier.credentialsSection')}</div>
              <div className={dossier.fieldStack}>
                <label className={dossier.fieldTag}>{credentialLabels[0]}</label>
                <input className={dossier.textIn} readOnly tabIndex={-1} value="cli_example" />
                <label className={dossier.fieldTag}>{credentialLabels[1]}</label>
                <input
                  className={dossier.textIn}
                  readOnly
                  tabIndex={-1}
                  value={typedText('****************', interval(time, 1600, 3000))}
                />
              </div>
            </section>
          </>
        ) : phase === 2 ? (
          <>
            <section className={dossier.slab}>
              <div className={dossier.slabCap}>{t('imPlugin.botName')}</div>
              <span>{name}</span>
            </section>
            <section className={dossier.slab}>
              <div className={dossier.slabCap}>{t('imPlugin.bindTaskDefinition')}</div>
              <span>{t('guides.workflows.templates.name')}</span>
            </section>
            <section className={dossier.slab} data-wide="true">
              <div className={dossier.slabCap}>{t('imPlugin.directMessageAccess')}</div>
              <div className={dossier.lever}>
                {DM_POLICY_KEYS.map(([id, key]) => (
                  <button key={id} type="button" data-on={id === 'pairing'}>
                    {t(key)}
                  </button>
                ))}
              </div>
              <div className={dossier.fieldNote}>{t('imPlugin.dossier.pairingExplanation')}</div>
            </section>
          </>
        ) : (
          <section className={dossier.slab} data-wide="true">
            <div className={dossier.slabCap}>
              {t(time > 4200 ? 'imPlugin.approvedSenders' : 'imPlugin.senderAuthorization')} · 1
            </div>
            {time < 4200 ? (
              <div className={dossier.askRow}>
                <span className={dossier.askWho}>
                  <b>{t('guides.workflows.messaging.visitor')}</b> · {t('imPlugin.dmChat')}
                </span>
                <span className={dossier.askCode}>482916</span>
                <span className={`${dossier.btn} ${dossier.btnLive}`} data-demo-target="true">
                  {t('imPlugin.approve')}
                </span>
                <span className={dossier.btn}>{t('imPlugin.reject')}</span>
              </div>
            ) : (
              <span className={dossier.userTag}>
                <Check size={13} />
                {t('guides.workflows.messaging.visitor')}
              </span>
            )}
          </section>
        )}
      </div>
      {phase === 1 && (
        <footer className={dossier.saveBar}>
          <span className={dossier.saveHint}>{t('imPlugin.dossier.immediateSaveHint')}</span>
          <span className={dossier.btn}>{t('common.cancel')}</span>
          <span
            className={`${dossier.btn} ${dossier.btnPrime}`}
            data-demo-target={phase === 1 || undefined}
          >
            {t('common.save')}
          </span>
        </footer>
      )}
    </div>
  );
}
