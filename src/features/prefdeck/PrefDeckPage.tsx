import { createUuid } from '@shared/utils/identifiers';
import { useWebSearchStore } from '../../store/webSearchStore';
import { SearchDesk } from './desks/SearchDesk';
import { SearchSettingsDesk } from './desks/SearchSettingsDesk';
import { SearchPresetForge } from './forge/SearchPresetForge';
/**
 * 设置页「双玻璃设置台」（路由 /preferences）。
 *
 * 装配:双玻璃舞台(左目录/右内容页)、`?sect=` 同步(兼容旧 `?tab=` 值)、
 * 推理配置订阅、瞬时提示条、三弹窗宿主(预设选择/模型编辑/代理表单)、图片放大镜。
 * 供应商目录规则与旧侧栏一致:驱动支持该网关,且(有模型时)存在该网关的模型。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import type { ProxyProfile } from '../../../shared/electron-contracts/configuration';
import type { InferenceModelDefinition } from '../../../shared/types/inference';
import {
  messageText,
  resolvePresentationText,
  type PresentationText,
} from '../../i18n/presentationText';
import { useInferenceStore } from '../../store/inferenceStore';
import { useProxyStore } from '../../store/proxyStore';
import { CatalogPane, type CatalogProviderItem, type DeckSect } from './CatalogPane';
import { AboutDesk } from './desks/AboutDesk';
import { AccountDesk } from './desks/AccountDesk';
import { GuideDesk } from './desks/GuideDesk';
import { AutoGuide } from '../guides/AutoGuide';
import { useModelGuideState } from '../guides/useModelGuideState';
import { KernelDesk } from './desks/KernelDesk';
import { LogDesk } from './desks/LogDesk';
import { LookDesk } from './desks/LookDesk';
import { ProviderDesk } from './desks/ProviderDesk';
import { ProxyDesk } from './desks/ProxyDesk';
import { TuningDesk } from './desks/TuningDesk';
import { ModelForge } from './forge/ModelForge';
import { PresetForge } from './forge/PresetForge';
import { ProxyForge } from './forge/ProxyForge';
import { matchVendor, type GatewayKind, type VendorSpec } from './data/vendor-atlas';
import styles from './deck.module.css';

const SECTS: readonly DeckSect[] = [
  'web-search', 'web-search-settings', 'ai', 'image', 'ai-tuning', 'image-tuning', 'proxy', 'account', 'look', 'kernel', 'logs', 'guides', 'about',
];

/** 旧 /settings 的 ?tab= 值映射 */
const TAB_BRIDGE: Record<string, DeckSect> = {
  ai: 'ai',
  'image-gen': 'image',
  proxy: 'proxy',
  system: 'look',
  logs: 'logs',
  about: 'about',
};

function sectFromSearch(search: string): DeckSect {
  const params = new URLSearchParams(search);
  const sect = params.get('sect');
  if (sect && (SECTS as readonly string[]).includes(sect)) return sect as DeckSect;
  const legacy = params.get('tab');
  if (legacy && TAB_BRIDGE[legacy]) return TAB_BRIDGE[legacy];
  return 'ai';
}

interface ForgeSession {
  gateway: GatewayKind;
  spec: VendorSpec;
  providerId?: string;
  modelId?: string;
  /** 会话号:宿主用它 key 重挂载弹窗 */
  run: number;
}

export const PrefDeckPage: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();

  const searchConfig = useWebSearchStore((s) => s.config);
  const searchPresets = useWebSearchStore((s) => s.presets);
  const searchError = useWebSearchStore((s) => s.error);
  const canAddSearchProvider = searchPresets.some((preset) => !searchConfig?.providers[preset.id]);
  const [pickedSearch, setPickedSearch] = useState<string | null>(null);
  const [searchForge, setSearchForge] = useState(false);
  const [searchSessionId] = useState(createUuid);
  const searchProviderId = pickedSearch && searchConfig?.providers[pickedSearch]
    ? pickedSearch : searchConfig?.defaultProvider ?? Object.keys(searchConfig?.providers ?? {})[0] ?? null;
  const searchErrorText = searchError ? resolvePresentationText(searchError, (key, values) => t(key, values)) : null;
  useEffect(() => {
    const store = useWebSearchStore.getState();
    void store.refresh().catch(() => undefined);
    return store.subscribeToConfigChanges();
  }, []);

  const config = useInferenceStore((s) => s.config);
  const drivers = useInferenceStore((s) => s.drivers);
  const models = useInferenceStore((s) => s.models);
  const catalogModels = useInferenceStore((s) => s.catalogModels);
  const selections = useInferenceStore((s) => s.selections);
  const inferenceError = useInferenceStore((s) => s.error);
  const clearInferenceError = useInferenceStore((s) => s.clearError);
  const refresh = useInferenceStore((s) => s.refresh);
  const subscribeInference = useInferenceStore((s) => s.subscribeToConfigChanges);
  const isLoading = useInferenceStore((s) => s.isLoading);
  const addProxy = useProxyStore((s) => s.addProxy);
  const updateProxy = useProxyStore((s) => s.updateProxy);

  const sect = sectFromSearch(location.search);
  const modelGuide = useModelGuideState();
  const [picked, setPicked] = useState<Record<GatewayKind, string | null>>({ ai: null, image: null });
  const [flash, setFlash] = useState<{
    text: PresentationText;
    tone: 'halt' | 'hold' | 'calm';
  } | null>(null);
  const [presetGateway, setPresetGateway] = useState<GatewayKind | null>(null);
  const [forge, setForge] = useState<ForgeSession | null>(null);
  const [proxyForge, setProxyForge] = useState<{ editing?: ProxyProfile } | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const shotRef = React.useRef<HTMLDialogElement>(null);
  const inferenceErrorText = inferenceError
    ? resolvePresentationText(inferenceError, (key, values) => t(key, values))
    : null;
  const flashText = flash
    ? resolvePresentationText(flash.text, (key, values) => t(key, values))
    : null;

  useEffect(() => {
    if ((!config || drivers.length === 0) && !isLoading) void refresh();
    // 初次装配拉一次即可;后续靠订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => subscribeInference(), [subscribeInference]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(timer);
  }, [flash]);

  useEffect(() => {
    const dialog = shotRef.current;
    if (!dialog) return;
    if (shot && !dialog.open) dialog.showModal();
    else if (!shot && dialog.open) dialog.close();
  }, [shot]);

  const onFlash = useCallback((text: PresentationText, tone: 'halt' | 'hold' | 'calm' = 'calm') => {
    setFlash({ text, tone });
  }, []);

  const gotoSect = useCallback((next: DeckSect) => {
    const params = new URLSearchParams(location.search);
    params.delete('tab');
    params.set('sect', next);
    navigate({ pathname: location.pathname, search: `?${params.toString()}` }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  /** 网关供应商目录:驱动支持该网关;有模型时须有该网关的模型 */
  const catalogOf = useCallback((gateway: GatewayKind): CatalogProviderItem[] => {
    if (!config) return [];
    const known = new Map(
      [...models.ai, ...models.image].map((definition: InferenceModelDefinition) => [definition.id, definition]),
    );
    return Object.entries(config.providers).flatMap(([id, provider]) => {
      const supported = drivers.find((driver) => driver.id === provider.driver)
        ?.supportedGateways.includes(gateway) ?? false;
      if (!supported) return [];
      const gatewayModels = Object.values(provider.models)
        .filter((binding) => known.get(binding.catalogId)?.kind === gateway);
      if (Object.keys(provider.models).length > 0 && gatewayModels.length === 0) return [];
      return [{
        id,
        title: provider.displayName,
        brand: matchVendor(provider, gateway).brand,
        modelCount: gatewayModels.length,
        active: selections?.[gateway]?.providerId === id,
      }];
    });
  }, [config, drivers, models, selections]);

  const aiCatalog = catalogOf('ai');
  const imageCatalog = catalogOf('image');
  const catalogs: Record<GatewayKind, readonly CatalogProviderItem[]> = { ai: aiCatalog, image: imageCatalog };

  /** 有效选中:失效(删除/过滤掉)时回落首个 */
  const effectivePicked = (gateway: GatewayKind): string | null => {
    const list = catalogs[gateway];
    const current = picked[gateway];
    if (current && list.some((item) => item.id === current)) return current;
    return list[0]?.id ?? null;
  };

  const openForge = (session: Omit<ForgeSession, 'run'>): void => {
    // 会话号取上个会话 +1(重挂载 key),保持纯函数式更新
    setForge((previous) => ({ ...session, run: (previous?.run ?? 0) + 1 }));
  };

  const renderDesk = (): React.ReactNode => {
    if (sect === 'web-search-settings') return <SearchSettingsDesk />;
    if (sect === 'web-search') {
      if (!searchProviderId) return <div className={styles.deskBody}><div className={styles.voidBox}>
        {t('settings.webSearch.empty')}
        <button type="button" className={`${styles.btn} ${styles.btnPrime}`} onClick={() => setSearchForge(true)}>{t('settings.preset.addProvider')}</button>
      </div></div>;
      return <SearchDesk key={searchProviderId} providerId={searchProviderId} sessionId={searchSessionId} onFlash={onFlash} />;
    }
    if (sect === 'ai' || sect === 'image') {
      const gateway = sect;
      const providerId = effectivePicked(gateway);
      if (!providerId) {
        return (
          <div className={styles.deskBody}>
            <div className={styles.voidBox}>
              {t(gateway === 'ai' ? 'settings.provider.emptyAi' : 'settings.provider.emptyImage')}
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrime}`}
                onClick={() => setPresetGateway(gateway)}
              >
                {t('settings.preset.addProvider')}
              </button>
            </div>
          </div>
        );
      }
      return (
        <ProviderDesk
          key={`${gateway}:${providerId}:${config?.revision ?? 0}`}
          gateway={gateway}
          providerId={providerId}
          onEditModel={(modelId) => {
            const provider = config?.providers[providerId];
            if (!provider) return;
            openForge({ gateway, spec: matchVendor(provider, gateway), providerId, modelId });
          }}
          onVanish={() => setPicked((current) => ({ ...current, [gateway]: null }))}
          onFlash={onFlash}
          onShowImage={setShot}
        />
      );
    }
    if (sect === 'ai-tuning') return <TuningDesk gateway="ai" />;
    if (sect === 'image-tuning') return <TuningDesk gateway="image" />;
    if (sect === 'proxy') {
      return <ProxyDesk onEdit={(proxy) => setProxyForge({ editing: proxy })} onFlash={onFlash} />;
    }
    if (sect === 'account') return <AccountDesk />;
    if (sect === 'look') return <LookDesk onFlash={onFlash} />;
    if (sect === 'kernel') return <KernelDesk onFlash={onFlash} />;
    if (sect === 'logs') return <LogDesk onFlash={onFlash} />;
    if (sect === 'guides') return <GuideDesk />;
    return <AboutDesk />;
  };

  const forgeProvider = forge?.providerId ? config?.providers[forge.providerId] : undefined;

  return (
    <div className={styles.stage}>
      {sect === 'ai' && <AutoGuide id="model-setup" ready={modelGuide.ready} eligible={!modelGuide.hasModel} />}
      {(inferenceErrorText || searchErrorText || flashText) && (
        <div className={styles.stripDock}>
          {searchErrorText && <div className={styles.strip} data-tone="halt" role="alert">
            <span className={styles.stripText}>{searchErrorText}</span>
            <button type="button" className={styles.stripClose} aria-label={t('common.close')} onClick={() => useWebSearchStore.getState().clearError()}><X size={12} /></button>
          </div>}
          {inferenceErrorText && (
            <div className={styles.strip} data-tone="halt" role="alert">
              <span className={styles.stripText} title={inferenceErrorText}>{inferenceErrorText}</span>
              <button
                type="button"
                className={styles.stripClose}
                aria-label={t('common.close')}
                onClick={clearInferenceError}
              >
                <X size={12} />
              </button>
            </div>
          )}
          {flash && flashText && (
            <div className={styles.strip} data-tone={flash.tone}>
              <span className={styles.stripText}>{flashText}</span>
              <button
                type="button"
                className={styles.stripClose}
                aria-label={t('common.close')}
                onClick={() => setFlash(null)}
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>
      )}

      <CatalogPane
        searchProviders={Object.entries(searchConfig?.providers ?? {}).map(([id, provider]) => ({ id, title: provider.displayName, active: searchConfig?.defaultProvider === id }))}
        pickedSearch={searchProviderId}
        onSearchProvider={(id) => { setPickedSearch(id); gotoSect('web-search'); }}
        onAddSearchProvider={canAddSearchProvider ? () => setSearchForge(true) : undefined}
        sect={sect}
        providers={catalogs}
        picked={{ ai: effectivePicked('ai'), image: effectivePicked('image') }}
        onSect={gotoSect}
        onProvider={(gateway, providerId) => {
          setPicked((current) => ({ ...current, [gateway]: providerId }));
          gotoSect(gateway);
        }}
        onAddProvider={(gateway) => setPresetGateway(gateway)}
      />

      <main className={`${styles.pane} ${styles.desk}`} aria-label={t('settings.catalog.contentAriaLabel')}>
        {renderDesk()}
      </main>

      {searchForge && <SearchPresetForge onClose={() => setSearchForge(false)} onAdded={(id) => {
        setSearchForge(false); setPickedSearch(id); gotoSect('web-search');
      }} />}
      {presetGateway && (
        <PresetForge
          gateway={presetGateway}
          onClose={() => setPresetGateway(null)}
          onPick={(spec) => {
            setPresetGateway(null);
            openForge({ gateway: presetGateway, spec });
          }}
        />
      )}

      {forge && (
        <ModelForge
          key={forge.run}
          gateway={forge.gateway}
          spec={forge.spec}
          providerId={forge.providerId}
          provider={forgeProvider}
          editingModelId={forge.modelId}
          definitions={models[forge.gateway]}
          catalogDefinitions={catalogModels[forge.gateway]}
          providerNames={Object.values(config?.providers ?? {}).map((provider) => provider.displayName)}
          onClose={() => setForge(null)}
          onSaved={(providerId) => {
            setPicked((current) => ({ ...current, [forge.gateway]: providerId }));
            gotoSect(forge.gateway);
          }}
          onFlash={onFlash}
        />
      )}

      {proxyForge && (
        <ProxyForge
          editing={proxyForge.editing}
          onClose={() => setProxyForge(null)}
          onSave={async (values) => {
            if (proxyForge.editing) {
              const saved = await updateProxy(proxyForge.editing.id, values);
              if (saved) {
                onFlash(messageText('settings.proxy.saved'));
                setProxyForge(null);
              } else onFlash(messageText('settings.proxy.updateFailed'), 'halt');
            } else {
              const created = await addProxy(values);
              if (created) {
                onFlash(messageText('settings.proxy.added'));
                setProxyForge(null);
              } else onFlash(messageText('settings.proxy.addFailed'), 'halt');
            }
          }}
        />
      )}

      {/* 生图测试结果放大镜 */}
      <dialog
        ref={shotRef}
        className={styles.shotShell}
        aria-label={t('settings.provider.testPreviewAria')}
        onClose={() => setShot(null)}
        onClick={() => setShot(null)}
      >
        {shot && <img src={shot} alt={t('settings.provider.testPreviewAlt')} />}
      </dialog>
    </div>
  );
};
