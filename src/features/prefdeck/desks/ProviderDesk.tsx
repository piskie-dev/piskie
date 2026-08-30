/**
 * 供应商详情页（双玻璃设置台 · AI/生图共用）。
 *
 * 页首:品牌铭牌 + 可就地重命名的标题 + 当前使用标 + 启用开关 + 测试连接 + 删除(两段)。
 * 正文:连接(密钥可见切换/复制/失焦保存、地址失焦保存、openai 驱动的线协议、网络代理)
 * + 模型清单(单选使用/能力徽章/思考摘要/探测结果(延迟·生图预览·失败摘要+原文可复制)
 *   /启用开关/编辑/删除两段)。
 * 语义红线:关闭 Provider 会连带清空选择(store 层已保证);测试连接前置校验
 * 启用态与可测模型;线协议切换后清空本地探测结果。
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Eye, EyeOff, Pencil, Plug2, Plus, Star } from 'lucide-react';

import type {
  InferenceModelBinding,
  InferenceModelDefinition,
  InferenceProbeReceipt,
} from '../../../../shared/types/inference';
import { Toggle } from '../../../components/task-definition/controls';
import {
  messageText,
  rawText,
  resolvePresentationText,
  type PresentationText,
} from '../../../i18n/presentationText';
import { useInferenceStore, type InferenceGatewayKind } from '../../../store/inferenceStore';
import { useProxyStore } from '../../../store/proxyStore';
import { modelReasoningSummary } from '../../../utils/reasoning-options';
import { BrandMark } from '../bits/BrandMark';
import { DeckSelect } from '../bits/DeckSelect';
import { briefProbeFailure, probeElapsedMs, type ProbeFailureBrief } from '../data/probe-brief';
import { matchVendor, peekKey, pokeKey, vendorLocaleKey } from '../data/vendor-atlas';
import { pickWire, readWirePact, stampWire } from '../data/wire-contract';
import styles from '../deck.module.css';

const DIRECT_LINE = '__direct__';

interface ProbeOutcome {
  phase: 'testing' | 'passed' | 'failed';
  elapsedMs?: number;
  failure?: ProbeFailureBrief;
  shotDataUrl?: string;
}

export interface ProviderDeskProps {
  readonly gateway: InferenceGatewayKind;
  readonly providerId: string;
  readonly onEditModel: (modelId?: string) => void;
  readonly onVanish: () => void;
  readonly onFlash: (text: PresentationText, tone?: 'halt' | 'hold' | 'calm') => void;
  readonly onShowImage: (dataUrl: string) => void;
}

export const ProviderDesk: React.FC<ProviderDeskProps> = ({
  gateway,
  providerId,
  onEditModel,
  onVanish,
  onFlash,
  onShowImage,
}) => {
  const { t } = useTranslation();
  const config = useInferenceStore((s) => s.config);
  const descriptor = useInferenceStore((s) => s.descriptors?.inference ?? null);
  const selections = useInferenceStore((s) => s.selections);
  const catalogModels = useInferenceStore((s) => s.models);
  const isApplying = useInferenceStore((s) => s.isApplying);
  const updateProvider = useInferenceStore((s) => s.updateProvider);
  const removeProvider = useInferenceStore((s) => s.removeProvider);
  const upsertProviderModel = useInferenceStore((s) => s.upsertProviderModel);
  const removeProviderModel = useInferenceStore((s) => s.removeProviderModel);
  const updateSelection = useInferenceStore((s) => s.updateSelection);
  const probe = useInferenceStore((s) => s.probe);
  const readArtifact = useInferenceStore((s) => s.readArtifact);
  const proxyPool = useProxyStore((s) => s.config);
  const fetchProxyPool = useProxyStore((s) => s.fetchConfig);

  const provider = config?.providers[providerId];

  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  const [keyShown, setKeyShown] = useState(false);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, ProbeOutcome>>({});
  const [armedKill, setArmedKill] = useState(false);
  const [armedModelId, setArmedModelId] = useState<string | null>(null);

  useEffect(() => {
    if (!proxyPool) void fetchProxyPool();
  }, [proxyPool, fetchProxyPool]);

  useEffect(() => {
    if (!armedKill) return;
    const timer = setTimeout(() => setArmedKill(false), 3000);
    return () => clearTimeout(timer);
  }, [armedKill]);

  useEffect(() => {
    if (!armedModelId) return;
    const timer = setTimeout(() => setArmedModelId(null), 3000);
    return () => clearTimeout(timer);
  }, [armedModelId]);

  // 被删(本页或事件流)→ 回目录默认位
  useEffect(() => {
    if (config && !provider) onVanish();
  }, [config, provider, onVanish]);

  if (!provider) return null;

  const spec = matchVendor(provider, gateway);
  const catalog = new Map(
    [...catalogModels.ai, ...catalogModels.image].map((definition) => [definition.id, definition]),
  );
  const rows = Object.entries(provider.models)
    .filter(([, binding]) => catalog.get(binding.catalogId)?.kind === gateway)
    .sort((left, right) => {
      const byEnabled = Number(right[1].enabled) - Number(left[1].enabled);
      if (byEnabled !== 0) return byEnabled;
      const l = catalog.get(left[1].catalogId);
      const r = catalog.get(right[1].catalogId);
      const byRelease = laterFirst(r?.releaseDate, l?.releaseDate);
      if (byRelease !== 0) return byRelease;
      return laterFirst(r?.source.updatedAt, l?.source.updatedAt) || left[0].localeCompare(right[0]);
    });

  const currentModelId = selections?.[gateway]?.providerId === providerId
    ? selections[gateway]!.modelId
    : undefined;
  const wirePact = gateway === 'ai' && provider.driver === 'openai' ? readWirePact(descriptor) : undefined;
  const storedKey = peekKey(provider.connection.auth);

  const proxyChoices = [
    { value: DIRECT_LINE, label: t('settings.provider.direct') },
    ...(proxyPool?.proxies ?? [])
      .filter((proxy) => proxy.enabled || proxy.id === provider.connection.proxyId)
      .map((proxy) => ({ value: proxy.id, label: proxy.name })),
  ];

  const commitName = async (): Promise<void> => {
    if (nameDraft === null) return;
    const next = nameDraft.trim();
    setNameDraft(null);
    if (!next) {
      onFlash(messageText('settings.provider.nameRequired'), 'hold');
      return;
    }
    if (next === provider.displayName) return;
    if (await updateProvider(providerId, { displayName: next })) {
      onFlash(messageText('settings.provider.nameUpdated'));
    }
  };

  const commitKey = async (): Promise<void> => {
    if (keyDraft === null || keyDraft === storedKey) {
      setKeyDraft(null);
      return;
    }
    const saved = await updateProvider(providerId, {
      connection: { auth: pokeKey(provider.connection.auth, keyDraft) },
    });
    setKeyDraft(null);
    if (saved) onFlash(messageText('settings.provider.apiKeyUpdated'));
  };

  const commitUrl = async (): Promise<void> => {
    if (urlDraft === null) return;
    const next = urlDraft.trim();
    setUrlDraft(null);
    if (next === provider.connection.baseUrl) return;
    if (await updateProvider(providerId, { connection: { baseUrl: next } })) {
      onFlash(messageText('settings.provider.apiUrlUpdated'));
    }
  };

  const switchWire = async (wireApi: string): Promise<void> => {
    const saved = await updateProvider(providerId, {
      driverOptions: stampWire(provider.driverOptions, wireApi),
    });
    if (!saved) return;
    setOutcomes({});
    const title = wirePact?.choices.find((choice) => choice.value === wireApi)?.title ?? wireApi;
    onFlash(messageText('settings.provider.protocolChanged', { title: rawText(title) }));
  };

  const runProbes = async (): Promise<void> => {
    if (!provider.enabled) {
      onFlash(messageText('settings.provider.enableProviderFirst'), 'hold');
      return;
    }
    const targets = rows.filter(([, binding]) => binding.enabled).map(([modelId]) => modelId);
    if (targets.length === 0) {
      onFlash(messageText('settings.provider.noEnabledModels'), 'hold');
      return;
    }
    setTesting(true);
    setOutcomes(Object.fromEntries(targets.map((modelId) => [modelId, { phase: 'testing' as const }])));
    try {
      let passed = 0;
      let firstFailure: PresentationText | null = null;
      for (const modelId of targets) {
        const receipts = await probe('smoke', { providerId, modelId });
        const receipt = receipts?.find((item) => item.modelId === modelId) ?? receipts?.[0];
        const outcome = await settleOutcome(gateway, receipt, readArtifact);
        if (outcome.phase === 'passed') passed += 1;
        else if (!firstFailure) {
          firstFailure = messageText('settings.provider.probeFailureWithModel', {
            model: rawText(modelId),
            reason: outcome.failure?.headline
              ?? messageText('settings.provider.probeNoResult'),
          });
        }
        setOutcomes((current) => ({ ...current, [modelId]: outcome }));
      }
      if (firstFailure) onFlash(firstFailure, 'halt');
      else onFlash(messageText('settings.provider.probePassed', { count: passed }));
    } finally {
      setTesting(false);
    }
  };

  const adoptModel = async (modelId: string, binding: InferenceModelBinding): Promise<void> => {
    if (!provider.enabled || !binding.enabled) {
      onFlash(messageText('settings.provider.enableProviderAndModel'), 'hold');
      return;
    }
    if (await updateSelection(gateway, { providerId, modelId })) {
      onFlash(messageText('settings.provider.currentModelChanged', { model: rawText(modelId) }));
    }
  };

  const killProvider = async (): Promise<void> => {
    if (!armedKill) {
      setArmedKill(true);
      return;
    }
    setArmedKill(false);
    if (await removeProvider(providerId)) {
      onFlash(messageText('settings.provider.providerDeleted', {
        name: rawText(provider.displayName),
      }));
      onVanish();
    }
  };

  const killModel = async (modelId: string): Promise<void> => {
    if (armedModelId !== modelId) {
      setArmedModelId(modelId);
      return;
    }
    setArmedModelId(null);
    if (await removeProviderModel(gateway, providerId, modelId)) {
      onFlash(messageText('settings.provider.modelDeleted'));
    }
  };

  return (
    <>
      <div className={styles.deskHead}>
        <span className={styles.deskGlyph}>
          <BrandMark brand={spec.brand} title={t(vendorLocaleKey(spec, 'title'))} size={22} />
        </span>
        <span className={styles.deskIdent}>
          <div className={styles.deskTitle}>
            {nameDraft !== null ? (
              <span className={styles.textIn} style={{ inlineSize: 220 }}>
                <input
                  autoFocus
                  value={nameDraft}
                  maxLength={40}
                  aria-label={t('settings.provider.providerName')}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onBlur={() => void commitName()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') setNameDraft(null);
                  }}
                />
              </span>
            ) : (
              <>
                <span>{provider.displayName}</span>
                <button
                  type="button"
                  className={styles.orbBtn}
                  aria-label={t('settings.provider.rename')}
                  title={t('settings.provider.rename')}
                  onClick={() => setNameDraft(provider.displayName)}
                >
                  <Pencil size={12} />
                </button>
              </>
            )}
          </div>
          <div className={styles.deskSub}>
            {currentModelId && (
              <span className={styles.liveTag}>{t('settings.provider.currentModel', { model: currentModelId })}</span>
            )}
            <span>{t('settings.provider.presetLabel', { name: t(vendorLocaleKey(spec, 'title')) })}</span>
            <span>{t(vendorLocaleKey(spec, 'brief'))}</span>
          </div>
        </span>
        <span className={styles.headSpring} />
        <span className={styles.headActs}>
          <Toggle
            on={provider.enabled}
            ariaLabel={t('settings.provider.enableProviderAria', { name: provider.displayName })}
            onFlip={(enabled) => void updateProvider(providerId, { enabled })}
          />
          <button
            type="button"
            className={styles.btn}
            disabled={testing || isApplying}
            title={wirePact ? t('settings.provider.protocolTestHint') : undefined}
            onClick={() => void runProbes()}
          >
            <Plug2 size={13} />
            {testing ? t('settings.provider.testing') : t('settings.provider.testConnection')}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnRisk} ${armedKill ? styles.btnArmed : ''}`}
            onClick={() => void killProvider()}
          >
            {armedKill ? t('settings.provider.confirmDelete') : t('common.delete')}
          </button>
        </span>
      </div>

      <div className={styles.deskBody}>
        <div className={styles.slab}>
          <div className={styles.slabCap}>{t('settings.provider.connection')}</div>

          {provider.connection.auth.kind !== 'none' && (
            <>
              <label className={styles.fieldTag}>{t('settings.provider.apiKey')}</label>
              <span className={`${styles.textIn} ${styles.monoIn}`}>
                <input
                  type={keyShown ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={keyDraft ?? storedKey}
                  placeholder={spec.keyHint}
                  aria-label={t('settings.provider.apiKey')}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  onBlur={() => void commitKey()}
                />
                <button
                  type="button"
                  className={styles.inMiniBtn}
                  aria-label={t(keyShown ? 'settings.provider.hideKey' : 'settings.provider.showKey')}
                  onClick={() => setKeyShown((shown) => !shown)}
                >
                  {keyShown ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  type="button"
                  className={styles.inMiniBtn}
                  aria-label={t('settings.provider.copyKey')}
                  onClick={() => {
                    const text = keyDraft ?? storedKey;
                    if (!text) return;
                    void navigator.clipboard.writeText(text);
                    onFlash(messageText('settings.provider.copied'));
                  }}
                >
                  <Copy size={13} />
                </button>
              </span>
            </>
          )}

          <label className={styles.fieldTag}>{t('settings.provider.apiUrl')}</label>
          <span className={styles.textIn}>
            <input
              value={urlDraft ?? provider.connection.baseUrl}
              placeholder={spec.baseUrl || t('settings.provider.apiUrlPlaceholder')}
              aria-label={t('settings.provider.apiUrl')}
              onChange={(event) => setUrlDraft(event.target.value)}
              onBlur={() => void commitUrl()}
            />
          </span>

          {wirePact && (
            <>
              <label className={styles.fieldTag}>{t('settings.provider.protocolShared')}</label>
              <DeckSelect
                ariaLabel={t('settings.provider.protocolAria', { name: provider.displayName })}
                options={wirePact.choices.map((choice) => ({
                  value: choice.value,
                  label: choice.title,
                  brief: choice.brief,
                }))}
                value={pickWire(provider.driverOptions, wirePact)}
                disabled={testing || isApplying}
                onPick={(wireApi) => void switchWire(wireApi)}
              />
              <div className={styles.fieldNote}>
                {[wirePact.brief, wirePact.impact].filter(Boolean).join(' ')}
              </div>
            </>
          )}

          <label className={styles.fieldTag}>{t('settings.provider.networkProxy')}</label>
          <DeckSelect
            ariaLabel={t('settings.provider.networkProxy')}
            options={proxyChoices}
            value={provider.connection.proxyId ?? DIRECT_LINE}
            onPick={(proxyId) => void updateProvider(providerId, {
              connection: { proxyId: proxyId === DIRECT_LINE ? null : proxyId },
            })}
          />
        </div>

        <div className={styles.slab}>
          <div className={styles.slabCap}>
            {t('settings.provider.modelCount', { count: rows.length })}
            <span className={styles.capSpring} />
            <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={() => onEditModel()}>
              <Plus size={12} /> {t('settings.provider.addModel')}
            </button>
          </div>

          {rows.length === 0 ? (
            <div className={styles.voidBox}>{t('settings.provider.noModels')}</div>
          ) : (
            rows.map(([modelId, binding]) => {
              const definition = catalog.get(binding.catalogId);
              const outcome = outcomes[modelId];
              return (
                <div key={modelId}>
                  <div className={styles.rowLine} data-hover="true" data-dim={!binding.enabled}>
                    <button
                      type="button"
                      className={styles.useOrb}
                      data-on={modelId === currentModelId}
                      aria-label={t('settings.provider.useModelAria', { model: modelId })}
                      title={t('settings.provider.setCurrent')}
                      onClick={() => void adoptModel(modelId, binding)}
                    />
                    <span className={styles.rowMain}>
                      <span className={styles.rowName}>
                        <span className={styles.monoNote} style={{ fontSize: 13 }}>{modelId}</span>
                        {definition?.displayName && definition.displayName !== modelId && (
                          <span className={styles.rowNote}>{definition.displayName}</span>
                        )}
                        {modelId === currentModelId && <Star size={11} className={styles.optCheck} />}
                      </span>
                      <span className={`${styles.rowNote} ${styles.monoNote}`}>
                        {gateway === 'ai'
                          ? [
                              definition?.limits.contextWindow ? shortTokens(definition.limits.contextWindow) : null,
                              modelReasoningSummary(definition?.reasoning, binding.defaultReasoning, t),
                            ].filter(Boolean).join(' · ')
                          : definition?.limits.sizes?.[0] ?? ''}
                      </span>
                    </span>

                    {gateway === 'ai' ? (
                      <>
                        <CapChip label={t('settings.provider.tools')} value={definition?.capabilities.tools} />
                        <CapChip label={t('settings.provider.vision')} value={definition?.capabilities.vision} />
                        <CapChip label={t('settings.provider.streaming')} value={definition?.capabilities.streaming} />
                      </>
                    ) : (
                      <>
                        <CapChip label={t('settings.provider.generate')} value={definition?.capabilities.generate} />
                        <CapChip label={t('settings.provider.editImage')} value={definition?.capabilities.edit} />
                        <CapChip label={t('settings.provider.referenceImages')} value={definition?.capabilities.referenceImages} />
                        <CapChip label={t('settings.provider.mask')} value={definition?.capabilities.mask} />
                        {typeof binding.options.workflowAssetId === 'string' && (
                          <span className={styles.chip} data-state="prime">{t('settings.provider.workflow')}</span>
                        )}
                      </>
                    )}
                    <LifecycleChip lifecycle={definition?.lifecycle} />
                    {outcome?.phase === 'testing' && <span className={styles.chip} data-state="warn">{t('settings.provider.testing')}</span>}
                    {outcome?.phase === 'passed' && (
                      <span className={styles.elapsedTag}>{t('settings.provider.connected', { latency: outcome.elapsedMs })}</span>
                    )}
                    {outcome?.phase === 'failed' && <span className={styles.chip} data-state="no">{t('settings.provider.failed')}</span>}

                    <span className={styles.rowActs}>
                      <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={() => onEditModel(modelId)}>
                        {t('settings.provider.edit')}
                      </button>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnQuiet} ${styles.btnRisk} ${armedModelId === modelId ? styles.btnArmed : ''}`}
                        onClick={() => void killModel(modelId)}
                      >
                        {armedModelId === modelId ? t('settings.provider.confirmDelete') : t('common.delete')}
                      </button>
                    </span>
                    <Toggle
                      on={binding.enabled}
                      ariaLabel={t('settings.provider.enableModelAria', { model: modelId })}
                      onFlip={(enabled) => {
                        void upsertProviderModel(gateway, providerId, modelId, { ...binding, enabled }, modelId);
                      }}
                    />
                  </div>

                  {outcome?.phase === 'passed' && outcome.shotDataUrl && (
                    <div className={styles.probeShot}>
                      <img
                        src={outcome.shotDataUrl}
                        alt={t('settings.provider.testImageAlt', { model: modelId })}
                        onClick={() => onShowImage(outcome.shotDataUrl!)}
                      />
                      <span className={styles.fieldNote}>
                        {t('settings.provider.testImageHint')}
                      </span>
                    </div>
                  )}

                  {outcome?.phase === 'failed' && outcome.failure && (
                    <div className={styles.probeFail}>
                      <div className={styles.probeFailMeta}>
                        {outcome.failure.httpStatus !== undefined && <span>HTTP {outcome.failure.httpStatus}</span>}
                        {outcome.failure.code && <span>code: {outcome.failure.code}</span>}
                        {outcome.failure.kind && <span>type: {outcome.failure.kind}</span>}
                        {outcome.failure.requestId && <span>requestId: {outcome.failure.requestId}</span>}
                        <span className={styles.capSpring} />
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnQuiet} ${styles.btnRisk}`}
                          onClick={() => {
                            void navigator.clipboard.writeText(outcome.failure!.rawText);
                            onFlash(messageText('settings.provider.copiedUpstreamError'));
                          }}
                        >
                          {t('settings.provider.copyError')}
                        </button>
                      </div>
                      <div className={styles.probeFailText}>
                        {resolvePresentationText(
                          outcome.failure.headline,
                          (key, values) => t(key, values),
                        )}
                      </div>
                      <pre aria-label={t('settings.provider.upstreamResponse')} className={styles.probeFailRaw}>{outcome.failure.rawText}</pre>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
};

function CapChip({ label, value }: { readonly label: string; readonly value: boolean | undefined }) {
  return (
    <span className={styles.chip} data-state={value === undefined ? 'warn' : value ? 'yes' : 'no'}>
      {label}
      {value === undefined ? ' ?' : value ? '' : ' ×'}
    </span>
  );
}

function LifecycleChip({ lifecycle }: { readonly lifecycle?: InferenceModelDefinition['lifecycle'] }) {
  const { t } = useTranslation();
  if (!lifecycle || lifecycle === 'active') return null;
  const word = lifecycle === 'preview'
    ? t('settings.tuning.lifecyclePreview')
    : lifecycle === 'deprecated'
      ? t('settings.tuning.lifecycleDeprecated')
      : t('settings.tuning.lifecycleRetired');
  return (
    <span className={styles.chip} data-state={lifecycle === 'preview' ? 'prime' : 'warn'}>{word}</span>
  );
}

async function settleOutcome(
  gateway: InferenceGatewayKind,
  receipt: InferenceProbeReceipt | undefined,
  readArtifact: (artifactId: string) => Promise<{ dataUrl: string } | null>,
): Promise<ProbeOutcome> {
  if (!receipt) {
    const storedError = useInferenceStore.getState().error;
    const headline = storedError ?? messageText('settings.provider.probeNoResult');
    return {
      phase: 'failed',
      failure: { headline, rawText: headline.kind === 'raw' ? headline.text : '' },
    };
  }
  if (!receipt.success) {
    return { phase: 'failed', failure: briefProbeFailure(receipt) };
  }
  if (gateway === 'image') {
    const artifact = receipt.artifacts?.[0];
    if (!artifact) {
      const headline = messageText('settings.provider.imageArtifactMissing');
      return { phase: 'failed', failure: { headline, rawText: '' } };
    }
    const preview = await readArtifact(artifact.artifactId);
    if (!preview) {
      const storedError = useInferenceStore.getState().error;
      const headline = storedError ?? messageText('settings.provider.imageReadFailed');
      return {
        phase: 'failed',
        failure: { headline, rawText: headline.kind === 'raw' ? headline.text : '' },
      };
    }
    return { phase: 'passed', elapsedMs: probeElapsedMs(receipt), shotDataUrl: preview.dataUrl };
  }
  return { phase: 'passed', elapsedMs: probeElapsedMs(receipt) };
}

function laterFirst(left?: string, right?: string): number {
  if (left && right) return left.localeCompare(right);
  if (left) return 1;
  if (right) return -1;
  return 0;
}

function shortTokens(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}
