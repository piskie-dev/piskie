import { Check, ChevronDown, Copy, Eye, Pencil, Plug2, Plus, RefreshCw, Search, Star, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { BrandMark } from '../prefdeck/bits/BrandMark';
import { vendorsFor, vendorLocaleKey, type GatewayKind } from '../prefdeck/data/vendor-atlas';
import { interval, typedText } from './planTimeline';
import type { BusinessFrameProps } from './SceneStage';
import deck from '../prefdeck/deck.module.css';
import task from '../../components/task-definition/taskDefinitionModal.module.css';
import s from './businessScenes.module.css';
import logo from '/logo-128.png';

function Field({
  label,
  value,
  focused,
  target,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly focused?: boolean;
  readonly target?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className={s.field}>
      <label className={deck.fieldTag}>{label}</label>
      <span
        className={deck.textIn}
        data-demo-focus={focused || undefined}
        data-demo-target={target || undefined}
      >
        <span className={s.value}>{value || '\u00a0'}</span>
        {children}
      </span>
    </div>
  );
}

function ForgeHead({ title, gateway }: { readonly title: string; readonly gateway?: GatewayKind }) {
  const { t } = useTranslation();
  return (
    <div className={deck.forgeHead}>
      {gateway && (
        <span className={deck.brandBox}>
          <BrandMark
            brand={gateway === 'ai' ? 'anthropic' : 'openai'}
            title={t(
              gateway === 'ai'
                ? 'settings.vendorCatalog.anthropic.title'
                : 'settings.vendorCatalog.openai.title'
            )}
            size={18}
          />
        </span>
      )}
      <span className={deck.forgeTitle}>{title}</span>
      <X size={14} />
    </div>
  );
}

export function ModelGuideFrame({
  phase,
  time,
  gateway = 'ai',
}: BusinessFrameProps & { readonly gateway?: GatewayKind }) {
  const { t } = useTranslation();
  const spec = vendorsFor(gateway).find(
    (v) => v.key === (gateway === 'ai' ? 'anthropic' : 'openai-image')
  )!;
  const model = gateway === 'ai' ? 'claude-sonnet-4-6' : 'gpt-image-1.5';
  const name = gateway === 'ai' ? 'Claude Sonnet 4.6' : 'gpt-image-1.5';
  const title = t(vendorLocaleKey(spec, 'title'));
  const selected = phase >= 2 || time > 4000;
  const progress = interval(time, 500, 2400);
  return (
    <div
      className={`${deck.skinVars} ${s.settings}`}
      data-guide-source={phase === 0 ? 'PresetForge' : phase < 3 ? 'ModelForge' : 'ProviderDesk'}
    >
      {phase === 0 ? (
        <div className={`${s.forge} ${s.vendorForge}`}>
          <ForgeHead title={t('settings.preset.addProvider')} />
          <div className={deck.wallTools}>
            <span className={deck.textIn}>
              <Search size={13} />
              <span className={s.placeholder}>{t('settings.preset.searchPlaceholder')}</span>
            </span>
            <span className={deck.lever}>
              {['all', 'flagshipAi', 'openHub', 'onPrem'].map((key, i) => (
                <button key={key} type="button" data-on={i === 0}>
                  {t(
                    `settings.preset.${gateway === 'image' && key === 'flagshipAi' ? 'flagshipImage' : key}`
                  )}
                </button>
              ))}
            </span>
          </div>
          <div className={deck.forgeBody}>
            <div className={deck.sectCap}>{t('settings.preset.wingFlagship')}</div>
            <div className={deck.brandWall}>
              {vendorsFor(gateway)
                .filter((v) => v.wing === 'flagship')
                .map((v) => (
                  <div
                    key={v.key}
                    className={deck.brandTile}
                    data-demo-target={v.key === spec.key || undefined}
                    data-demo-focus={(v.key === spec.key && time > 3300) || undefined}
                  >
                    <span className={deck.tileMark}>
                      <BrandMark brand={v.brand} title={t(vendorLocaleKey(v, 'title'))} size={23} />
                    </span>
                    <span className={deck.tileName}>{t(vendorLocaleKey(v, 'title'))}</span>
                  </div>
                ))}
            </div>
            <div className={deck.sectCap}>{t('settings.preset.wingDiy')}</div>
            <div className={deck.brandWall}>
              {vendorsFor(gateway)
                .filter((v) => v.wing === 'diy')
                .map((v) => (
                  <div key={v.key} className={deck.brandTile}>
                    <BrandMark brand={v.brand} title={t(vendorLocaleKey(v, 'title'))} size={20} />
                    <span className={deck.tileName}>{t(vendorLocaleKey(v, 'title'))}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      ) : phase < 3 ? (
        <div className={s.forge}>
          <ForgeHead title={t('settings.modelForge.addModel')} gateway={gateway} />
          <div className={deck.forgeBody}>
            {phase === 1 && (
              <section className={deck.forgeSect}>
                <div className={deck.sectCap}>{t('settings.modelForge.connectionSection')}</div>
                <div className={deck.duoGrid}>
                  <Field label={t('settings.provider.providerName')} value={title} />
                  <Field
                    label={t('settings.provider.networkProxy')}
                    value={t('settings.provider.direct')}
                  >
                    <ChevronDown size={11} />
                  </Field>
                </div>
                <Field label={t('settings.provider.apiUrl')} value={spec.baseUrl} />
                <Field
                  label={t('settings.provider.apiKey')}
                  value={typedText('********************', progress)}
                  focused={time < 2600}
                />
              </section>
            )}
            <section className={deck.forgeSect}>
              <div className={deck.sectCap}>
                {t('settings.modelForge.modelSection')}
                <button type="button" className={`${deck.orbBtn} ${deck.catalogRefreshBtn}`}
                  aria-label={t('settings.modelForge.refreshCatalog')}>
                  <RefreshCw size={12} aria-hidden />
                </button>
              </div>
              <div className={deck.duoGrid}>
                <div className={deck.dropWrap}>
                  <Field
                    label={t('settings.modelForge.modelIdHint')}
                    value={selected ? model : time > 2700 ? (gateway === 'ai' ? 'son' : 'gpt') : ''}
                    focused={phase === 1 && time > 2700 && !selected}
                  />
                  {phase === 1 && time > 2700 && time < 4200 && (
                    <div className={`${deck.dropCard} ${s.suggestions}`}>
                      <div className={deck.dropOpt} data-on="true" data-demo-target="true">
                        <span className={deck.optMain}>
                          {name}
                          <small className={s.modelId}>{model}</small>
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                <Field label={t('settings.modelForge.displayName')} value={selected ? name : ''} />
              </div>
            </section>
            {phase === 2 && (
              <section className={deck.forgeSect}>
                <div className={deck.sectCap}>
                  {t(
                    gateway === 'ai'
                      ? 'settings.modelForge.aiCapabilitiesSection'
                      : 'settings.modelForge.imageCapabilitiesSection'
                  )}
                </div>
                <div className={deck.trioGrid}>
                  {(gateway === 'ai'
                    ? ['tools', 'vision', 'streaming']
                    : ['generate', 'editImage', 'referenceImages']
                  ).map((key) => (
                    <Field
                      key={key}
                      label={t(`settings.provider.${key}`)}
                      value={t('settings.modelForge.capabilitySupported')}
                    >
                      <ChevronDown size={10} />
                    </Field>
                  ))}
                </div>
                {gateway === 'ai' ? (
                  <>
                    <div>
                      <label className={deck.fieldTag}>
                        {t('settings.modelForge.defaultReasoningAria')}
                      </label>
                      <div className={deck.reasonRack}>
                        {['low', 'medium', 'high', 'max'].map((effort) => (
                          <span
                            key={effort}
                            className={deck.reasonPick}
                            aria-checked={effort === 'high'}
                          >
                            {t(`reasoning.effort.${effort}`)}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className={deck.sectCap}>{t('settings.modelForge.limitsSection')}</div>
                    <div className={deck.duoGrid}>
                      <Field label={t('settings.modelForge.contextWindow')} value="1000000" />
                      <Field label={t('settings.modelForge.maxOutput')} value="128000" />
                    </div>
                  </>
                ) : (
                  <div className={deck.duoGrid}>
                    <Field label={t('settings.modelForge.outputFormat')} value="png" />
                    <Field label={t('settings.modelForge.maxImages')} value="1" />
                  </div>
                )}
              </section>
            )}
          </div>
          <div className={deck.forgeFoot}>
            <span className={task.toggle} data-on="true" />
            <span>{t('settings.modelForge.enabled')}</span>
            <span className={deck.footHint} />
            <span className={`${deck.btn} ${deck.btnQuiet}`}>{t('common.cancel')}</span>
            <span
              className={`${deck.btn} ${deck.btnPrime}`}
              data-demo-target={phase === 2 || undefined}
            >
              {t('settings.modelForge.addModel')}
            </span>
          </div>
        </div>
      ) : (
        <div className={s.provider}>
          <div className={deck.deskHead}>
            <span className={deck.deskGlyph}>
              <BrandMark brand={spec.brand} title={title} size={22} />
            </span>
            <span className={deck.deskIdent}>
              <span className={deck.deskTitle}>
                {title}
                <Pencil size={11} />
              </span>
              <span className={deck.deskSub}>
                {t('settings.provider.presetLabel', { name: title })}
              </span>
            </span>
            <span className={deck.headSpring} />
            <span className={task.toggle} data-on="true" />
            <span className={deck.btn} data-demo-target={time < 4400 || undefined}>
              <Plug2 size={13} />
              {t(
                time > 4000 && time < 4800
                  ? 'settings.provider.testing'
                  : 'settings.provider.testConnection'
              )}
            </span>
          </div>
          <div className={deck.deskBody}>
            {(gateway === 'ai' || time <= 4800) && (
              <section className={deck.slab}>
                <div className={deck.slabCap}>{t('settings.provider.connection')}</div>
                <Field label={t('settings.provider.apiKey')} value="********************">
                  <Eye size={12} />
                  <Copy size={12} />
                </Field>
                <Field label={t('settings.provider.apiUrl')} value={spec.baseUrl} />
                <Field
                  label={t('settings.provider.networkProxy')}
                  value={t('settings.provider.direct')}
                >
                  <ChevronDown size={11} />
                </Field>
              </section>
            )}
            <section className={deck.slab}>
              <div className={deck.slabCap}>
                {t('settings.provider.modelCount', { count: 1 })}
                <span className={deck.capSpring} />
                <span className={`${deck.btn} ${deck.btnQuiet}`}>
                  <Plus size={11} />
                  {t('settings.provider.addModel')}
                </span>
              </div>
              <div className={deck.rowLine}>
                <span className={deck.useOrb} data-on="true" />
                <span className={deck.rowMain}>
                  <span className={deck.rowName}>
                    {model}
                    <Star size={11} />
                  </span>
                  <span className={deck.rowNote}>
                    {t(
                      gateway === 'ai'
                        ? 'guides.examples.contextWindow'
                        : 'guides.examples.imageSize'
                    )}
                  </span>
                </span>
                <span className={task.toggle} data-on="true" />
                {time > 4800 && (
                  <span className={deck.elapsedTag}>
                    {t('settings.provider.connected', { latency: 842 })}
                  </span>
                )}
              </div>
              {gateway === 'image' && time > 4800 && (
                <div className={`${deck.probeShot} ${s.imageResult}`}>
                  <img src={logo} alt="" />
                  <span className={deck.fieldNote}>{t('guides.workflows.image.result')}</span>
                </div>
              )}
            </section>
            {time > 4800 && (
              <div className={s.receipt}>
                <Check size={13} />
                {t('settings.provider.probePassed', { count: 1 })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ProxyGuideFrame({ phase, time }: BusinessFrameProps) {
  const { t } = useTranslation();
  const name = t('guides.workflows.proxy.name');
  return (
    <div
      className={`${deck.skinVars} ${s.settings}`}
      data-guide-source={phase === 1 ? 'ProxyForge' : phase < 3 ? 'ProxyDesk' : 'ProviderDesk'}
    >
      {phase === 0 ? (
        <div className={s.provider}>
          <div className={deck.deskHead}>
            <span className={deck.deskTitle}>{t('settings.proxy.pageTitle')}</span>
            <span className={deck.headSpring} />
            <span className={`${deck.btn} ${deck.btnPrime}`} data-demo-target="true">
              <Plus size={13} />
              {t('settings.proxy.add')}
            </span>
          </div>
          <div className={deck.deskBody}>
            <div className={deck.voidBox}>{t('settings.proxy.empty')}</div>
          </div>
        </div>
      ) : phase === 1 ? (
        <div className={s.forge}>
          <ForgeHead title={t('settings.proxy.addTitle')} />
          <div className={deck.forgeBody}>
            <section className={deck.forgeSect}>
              <div className={deck.sectCap}>{t('settings.proxy.targetSection')}</div>
              <div className={deck.duoGrid}>
                <Field
                  label={t('settings.proxy.name')}
                  value={phase ? name : typedText(name, interval(time, 500, 2200))}
                />
                <div>
                  <label className={deck.fieldTag}>{t('settings.proxy.protocol')}</label>
                  <span className={deck.lever}>
                    {['HTTP', 'HTTPS', 'SOCKS5'].map((protocol) => (
                      <button type="button" key={protocol} data-on={protocol === 'HTTP'}>
                        {protocol}
                      </button>
                    ))}
                  </span>
                </div>
              </div>
              <div className={deck.duoGrid}>
                <Field label={t('settings.proxy.host')} value="127.0.0.1" />
                <Field label={t('settings.proxy.port')} value="7890" />
              </div>
            </section>
            <section className={deck.forgeSect}>
              <div className={deck.sectCap}>{t('settings.proxy.credentialsSection')}</div>
              <div className={deck.duoGrid}>
                <Field label={t('settings.proxy.username')} value="" />
                <Field label={t('settings.proxy.password')} value="" />
              </div>
            </section>
          </div>
          <div className={deck.forgeFoot}>
            <span className={task.toggle} data-on="true" />
            {t('settings.proxy.enabled')}
            <span className={deck.footHint} />
            <span className={deck.btn}>{t('common.cancel')}</span>
            <span className={`${deck.btn} ${deck.btnPrime}`} data-demo-target="true">
              {t('common.save')}
            </span>
          </div>
        </div>
      ) : phase === 2 ? (
        <div className={s.provider}>
          <ForgeHead title={t('settings.proxy.pageTitle')} />
          <div className={deck.deskBody}>
            <div className={deck.rowLine}>
              <span className={deck.rowMain}>
                <span className={deck.rowName}>{name}</span>
                <span className={deck.rowNote}>{t('guides.examples.proxyAddress')}</span>
              </span>
              <span className={task.toggle} data-on="true" />
              <span className={deck.btn} data-demo-target="true">
                <Plug2 size={13} />
                {t('settings.proxy.test')}
              </span>
            </div>
            {time > 4200 && (
              <div className={s.receipt}>
                <Check size={13} />
                {t('guides.workflows.proxy.success')}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={s.provider}>
          <ForgeHead title={t('settings.vendorCatalog.anthropic.title')} gateway="ai" />
          <div className={deck.deskBody}>
            <section className={deck.slab}>
              <div className={deck.slabCap}>{t('settings.provider.connection')}</div>
              <Field label={t('settings.provider.apiUrl')} value="https://api.anthropic.com" />
              <Field
                label={t('settings.provider.networkProxy')}
                value={time < 4000 ? t('settings.provider.direct') : name}
                target
              >
                <ChevronDown size={12} />
              </Field>
              {time < 4200 && (
                <div className={s.inlineOptions}>
                  <div className={deck.dropOpt}>{t('settings.provider.direct')}</div>
                  <div className={deck.dropOpt} data-on="true">
                    {name}
                    <Check size={12} />
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
