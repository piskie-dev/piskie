/**
 * 模型编辑弹窗（原生 dialog 重写,承接旧 ModelEditorModal 全语义）。
 *
 * 三形态:AI 模型 / 生图模型 / ComfyUI 工作流。
 * - 新建供应商态:代理/名称(唯一化建议)/API 密钥(按预设鉴权形态)/API 地址
 * - 模型 ID 联想:兼容目录过滤(驱动兼容+家族+非本地;自定义预设只列已绑定目录),
 *   选中回填全套能力与上限;手动改动即脱钩目录并清空回填;显示名跟随未手改的 ID
 * - AI:能力三态×3 + 思考协议(仅自定义预设可改)+ 默认思考程度 + 上下文窗口(必填)+ 最大输出
 * - 生图:能力三态×4 + 尺寸 tags + 格式多选 + 最大张数
 * - Comfy:工作流 JSON 导入(内容哈希资产)→ inspect + detectBindings → 字段映射
 *   (提示词必选)+ 输出节点多选(save/preview 启发式建议)→ validateBindings
 * - 保存:目录模型按需 upsert(与所选定义等价则跳过)→ 绑定 upsert(改 ID 先迁移)
 *   → 新供应商整装入库(forgeAuth)
 * 宿主按会话 key 重挂载本组件;所有草稿在挂载时一次成型。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UploadCloud, X } from 'lucide-react';

import { NO_REASONING, profileForReasoningTransport } from '../../../../shared/ai-model-catalog';
import { MIN_CONTEXT_WINDOW } from '../../../../shared/constants/token';
import type { CapabilityState } from '../../../../shared/types/model-catalog';
import type {
  ReasoningProfile,
  ReasoningSelection,
  ReasoningTransportPreset,
} from '../../../../shared/types/reasoning';
import type {
  InferenceComfyWorkflowBindingCandidates,
  InferenceModelBinding,
  InferenceModelDefinition,
  InferenceProviderInstance,
} from '../../../../shared/types/inference';
import { Toggle } from '../../../components/task-definition/controls';
import { useNativeDialog } from '../../../components/task-definition/useNativeDialog';
import {
  messageText,
  PresentationError,
  presentationFromError,
  rawText,
  resolvePresentationText,
  type PresentationText,
  type PresentationValue,
} from '../../../i18n/presentationText';
import {
  createProviderId,
  customCatalogId,
  useInferenceStore,
  type InferenceGatewayKind,
} from '../../../store/inferenceStore';
import { useProxyStore } from '../../../store/proxyStore';
import {
  getSelectableReasoningOptions,
  reasoningOptionKey,
  reasoningSelectionLabel,
  resolveSelectableReasoning,
} from '../../../utils/reasoning-options';
import { BrandMark } from '../bits/BrandMark';
import { ComboInput } from '../bits/ComboInput';
import { DeckSelect } from '../bits/DeckSelect';
import {
  BLANK_COMFY,
  buildComfyBindings,
  comfyDraftOf,
  composeCatalogModel,
  equalCatalogShape,
  freshFirst,
  sealBinding,
  suggestOutputNodes,
  triOf,
  wireIdOf,
  type ComfyDraft,
} from '../data/model-forge-kit';
import {
  coinDisplayName,
  defaultTransportOf,
  familyOf,
  forgeAuth,
  peekKey,
  transportEditable,
  vendorLocaleKey,
  type VendorSpec,
} from '../data/vendor-atlas';
import styles from '../deck.module.css';

const DIRECT_LINE = '__direct__';
const IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const;

function fail(
  key: string,
  values?: Readonly<Record<string, PresentationValue>>,
): never {
  throw new PresentationError(messageText(key, values));
}

/** 思考参数传输协议清单(仅自定义预设可改) */
const TRANSPORT_CHOICES: ReadonlyArray<{
  value: ReasoningTransportPreset;
  label?: string;
  labelKey?: string;
}> = [
  { value: 'none', labelKey: 'settings.modelForge.transportNone' },
  { value: 'openai-effort', label: 'OpenAI reasoning_effort' },
  { value: 'openai-reasoning-object', label: 'OpenAI reasoning.effort' },
  { value: 'anthropic-adaptive-effort', label: 'Anthropic adaptive + effort' },
  { value: 'anthropic-budget', label: 'Anthropic thinking budget' },
  { value: 'gemini-effort', label: 'Gemini reasoning_effort' },
  { value: 'deepseek-thinking', labelKey: 'settings.modelForge.transportDeepseek' },
  { value: 'dashscope-enable-thinking', label: 'DashScope enable_thinking' },
  { value: 'minimax-thinking', labelKey: 'settings.modelForge.transportMinimax' },
  { value: 'volcengine-reasoning', labelKey: 'settings.modelForge.transportVolcengine' },
  { value: 'together-reasoning', label: 'Together reasoning' },
  { value: 'fireworks-reasoning', label: 'Fireworks reasoning' },
  { value: 'openrouter-reasoning', label: 'OpenRouter reasoning' },
  { value: 'ollama-think', labelKey: 'settings.modelForge.transportOllama' },
];

const TRI_CHOICES = [
  { value: 'unknown', labelKey: 'settings.modelForge.capabilityUnknown' },
  { value: 'supported', labelKey: 'settings.modelForge.capabilitySupported' },
  { value: 'unsupported', labelKey: 'settings.modelForge.capabilityUnsupported' },
];

export interface ModelForgeProps {
  readonly gateway: InferenceGatewayKind;
  readonly spec: VendorSpec;
  readonly providerId?: string;
  readonly provider?: InferenceProviderInstance;
  readonly editingModelId?: string;
  readonly definitions: readonly InferenceModelDefinition[];
  readonly providerNames: readonly string[];
  readonly onClose: () => void;
  readonly onSaved: (providerId: string) => void;
  readonly onFlash: (text: PresentationText, tone?: 'halt' | 'hold' | 'calm') => void;
}

export const ModelForge: React.FC<ModelForgeProps> = ({
  gateway,
  spec,
  providerId,
  provider,
  editingModelId,
  definitions,
  providerNames,
  onClose,
  onSaved,
  onFlash,
}) => {
  const { t } = useTranslation();
  const dialogRef = useNativeDialog(true, onClose);
  const addProvider = useInferenceStore((s) => s.addProvider);
  const upsertProviderModel = useInferenceStore((s) => s.upsertProviderModel);
  const upsertCatalogModel = useInferenceStore((s) => s.upsertCatalogModel);
  const proxyPool = useProxyStore((s) => s.config);
  const fetchProxyPool = useProxyStore((s) => s.fetchConfig);

  const isNewProvider = !providerId || !provider;
  const isComfy = spec.driver === 'comfyui-workflow';
  const editingBinding = editingModelId ? provider?.models[editingModelId] : undefined;
  const editingDefinition = definitions.find((item) => item.id === editingBinding?.catalogId);
  const specProfile = useMemo<ReasoningProfile>(() => (
    gateway === 'ai' ? profileForReasoningTransport(defaultTransportOf(spec)) : NO_REASONING
  ), [gateway, spec]);

  /** 兼容目录:驱动兼容 → 自定义预设只列已绑定;内置预设按家族过滤且排除本地目录 */
  const compatibleDefs = useMemo(() => {
    const byDriver = definitions.filter((item) => item.compatibleDrivers.includes(spec.driver));
    if (spec.wing === 'diy') {
      if (!providerId || !provider) return [];
      const bound = new Set(Object.values(provider.models).map((binding) => binding.catalogId));
      return byDriver.filter((item) => bound.has(item.id));
    }
    return byDriver
      .filter((item) => item.family === familyOf(spec) && item.source.kind !== 'local')
      .sort(freshFirst);
  }, [definitions, provider, providerId, spec]);

  // ── 挂载即成型的草稿(宿主按会话 key 重挂载) ──
  const seedDefinition = editingDefinition
    ?? (isNewProvider && spec.wing !== 'diy' && !isComfy ? compatibleDefs[0] : undefined);
  const seedModelId = editingModelId ?? (seedDefinition ? wireIdOf(seedDefinition) : '');
  const seedComfy = comfyDraftOf(editingBinding);

  const localizedVendorTitle = t(vendorLocaleKey(spec, 'title'));
  const localizedVendorBrief = t(vendorLocaleKey(spec, 'brief'));
  const [providerName, setProviderName] = useState(() => coinDisplayName(localizedVendorTitle, [...providerNames]));
  const [modelId, setModelId] = useState(seedModelId);
  const [displayName, setDisplayName] = useState(seedDefinition?.displayName ?? seedModelId);
  const [nameEdited, setNameEdited] = useState(false);
  const [enabled, setEnabled] = useState(editingBinding?.enabled ?? true);
  const [baseUrl, setBaseUrl] = useState(provider?.connection.baseUrl ?? spec.baseUrl);
  const [apiKey, setApiKey] = useState(provider ? peekKey(provider.connection.auth) : '');
  const [proxyId, setProxyId] = useState(provider?.connection.proxyId ?? DIRECT_LINE);
  const [contextWindow, setContextWindow] = useState(
    seedDefinition?.limits.contextWindow != null ? String(seedDefinition.limits.contextWindow) : '',
  );
  const [maxOutput, setMaxOutput] = useState(
    seedDefinition?.limits.maxOutputTokens != null ? String(seedDefinition.limits.maxOutputTokens) : '',
  );
  type TriKey = 'tools' | 'vision' | 'streaming'
    | 'imageGenerate' | 'imageEdit' | 'imageReferenceImages' | 'imageMask';
  const [tris, setTris] = useState<Record<TriKey, CapabilityState>>({
    tools: triOf(seedDefinition?.capabilities.tools),
    vision: triOf(seedDefinition?.capabilities.vision),
    streaming: triOf(seedDefinition?.capabilities.streaming),
    imageGenerate: triOf(seedDefinition?.capabilities.generate),
    imageEdit: triOf(seedDefinition?.capabilities.edit),
    imageReferenceImages: triOf(seedDefinition?.capabilities.referenceImages),
    imageMask: triOf(seedDefinition?.capabilities.mask),
  });
  const [imageSizes, setImageSizes] = useState<string[]>(seedDefinition?.limits.sizes ?? []);
  const [sizeDraft, setSizeDraft] = useState('');
  const [imageFormats, setImageFormats] = useState<Array<'png' | 'jpeg' | 'webp'>>(
    seedDefinition?.limits.formats ?? [],
  );
  const [maxImages, setMaxImages] = useState(
    seedDefinition?.limits.maxImages != null ? String(seedDefinition.limits.maxImages) : '',
  );
  const [pickedCatalogId, setPickedCatalogId] = useState<string | undefined>(
    editingBinding?.catalogId ?? seedDefinition?.id,
  );
  const [pickedWireId, setPickedWireId] = useState<string | undefined>(
    editingBinding?.upstreamId ?? (seedDefinition ? wireIdOf(seedDefinition) : undefined),
  );
  const [thinkProfile, setThinkProfile] = useState<ReasoningProfile>(
    seedDefinition?.reasoning ?? specProfile,
  );
  const [thinkPick, setThinkPick] = useState<ReasoningSelection | undefined>(
    editingBinding?.defaultReasoning ?? (seedDefinition?.reasoning ?? specProfile).defaultSelection,
  );
  const [comfy, setComfy] = useState<ComfyDraft>(seedComfy);
  const [candidates, setCandidates] = useState<InferenceComfyWorkflowBindingCandidates | undefined>(undefined);
  // 既有 Comfy 绑定挂载即进入解析态(effect 内不做同步 setState)
  const [comfyBusy, setComfyBusy] = useState(() => Boolean(seedComfy.assetId));
  const [dragOver, setDragOver] = useState(false);
  const [fault, setFault] = useState<PresentationText | null>(null);
  const [saving, setSaving] = useState(false);
  const faultText = fault
    ? resolvePresentationText(fault, (key, values) => t(key, values))
    : null;

  useEffect(() => {
    if (!proxyPool) void fetchProxyPool();
  }, [proxyPool, fetchProxyPool]);

  // 既有 Comfy 绑定:挂载后加载资产的 inspect/candidates
  const seedAssetId = seedComfy.assetId;
  useEffect(() => {
    if (!seedAssetId) return;
    let stale = false;
    void Promise.all([
      window.piskie.inference.inspectWorkflow(seedAssetId),
      window.piskie.inference.detectBindings(seedAssetId),
    ]).then(([inspection, detected]) => {
      if (stale) return;
      setCandidates(detected);
      setComfy((current) => ({
        ...current,
        inspection,
        prompt: current.prompt ?? sealBinding(detected.prompt[0]),
        seed: current.seed ?? sealBinding(detected.seed[0]),
        width: current.width ?? sealBinding(detected.width[0]),
        height: current.height ?? sealBinding(detected.height[0]),
        batch: current.batch ?? sealBinding(detected.batch[0]),
        outputNodeIds: current.outputNodeIds.length > 0
          ? current.outputNodeIds
          : suggestOutputNodes(inspection),
      }));
    }).catch((error: unknown) => {
      if (!stale) {
        setFault(presentationFromError(
          error,
          messageText('settings.modelForge.operationFailed'),
        ));
      }
    }).finally(() => {
      if (!stale) setComfyBusy(false);
    });
    return () => {
      stale = true;
    };
  }, [seedAssetId]);

  const importWorkflow = async (file: File): Promise<void> => {
    setComfyBusy(true);
    setFault(null);
    try {
      const imported = await window.piskie.inference.importWorkflow(await file.text());
      const [inspection, detected] = await Promise.all([
        window.piskie.inference.inspectWorkflow(imported.id),
        window.piskie.inference.detectBindings(imported.id),
      ]);
      setCandidates(detected);
      setComfy({
        ...BLANK_COMFY,
        assetId: imported.id,
        inspection,
        prompt: sealBinding(detected.prompt[0]),
        seed: sealBinding(detected.seed[0]),
        width: sealBinding(detected.width[0]),
        height: sealBinding(detected.height[0]),
        batch: sealBinding(detected.batch[0]),
        outputNodeIds: suggestOutputNodes(inspection),
      });
      if (!modelId) {
        const stem = file.name.replace(/\.json$/i, '');
        setModelId(stem);
        if (!nameEdited) setDisplayName(stem);
      }
      onFlash(messageText('settings.modelForge.workflowImported'));
    } catch (error) {
      setFault(presentationFromError(
        error,
        messageText('settings.modelForge.operationFailed'),
      ));
    } finally {
      setComfyBusy(false);
    }
  };

  /** 选中目录建议:回填全套能力与上限 */
  const adoptDefinition = (wireId: string, catalogId: string): void => {
    const definition = definitions.find((item) => item.id === catalogId);
    if (!definition) return;
    setPickedCatalogId(definition.id);
    setPickedWireId(wireId);
    setModelId(wireId);
    setNameEdited(false);
    setDisplayName(definition.displayName);
    setContextWindow(definition.limits.contextWindow != null ? String(definition.limits.contextWindow) : '');
    setMaxOutput(definition.limits.maxOutputTokens != null ? String(definition.limits.maxOutputTokens) : '');
    setTris({
      tools: triOf(definition.capabilities.tools),
      vision: triOf(definition.capabilities.vision),
      streaming: triOf(definition.capabilities.streaming),
      imageGenerate: triOf(definition.capabilities.generate),
      imageEdit: triOf(definition.capabilities.edit),
      imageReferenceImages: triOf(definition.capabilities.referenceImages),
      imageMask: triOf(definition.capabilities.mask),
    });
    setImageSizes(definition.limits.sizes ?? []);
    setImageFormats(definition.limits.formats ?? []);
    setMaxImages(definition.limits.maxImages != null ? String(definition.limits.maxImages) : '');
    const profile = definition.reasoning ?? specProfile;
    setThinkProfile(profile);
    setThinkPick(profile.defaultSelection);
  };

  /** 手动改动模型 ID:脱钩目录,清空回填 */
  const detachDefinition = (value: string): void => {
    setModelId(value);
    if (value !== pickedWireId) {
      if (pickedCatalogId) {
        setContextWindow('');
        setMaxOutput('');
        setTris({
          tools: 'unknown',
          vision: 'unknown',
          streaming: 'unknown',
          imageGenerate: 'unknown',
          imageEdit: 'unknown',
          imageReferenceImages: 'unknown',
          imageMask: 'unknown',
        });
        setImageSizes([]);
        setImageFormats([]);
        setMaxImages('');
        setThinkProfile(specProfile);
        setThinkPick(specProfile.defaultSelection);
      }
      setPickedCatalogId(undefined);
    }
    if (!nameEdited) setDisplayName(value);
  };

  const suggestions = compatibleDefs.map((definition) => {
    const bound = provider && Object.values(provider.models)
      .find((binding) => binding.catalogId === definition.id);
    const value = bound?.upstreamId ?? wireIdOf(definition);
    return { value, label: `${definition.displayName} · ${value}`, payload: definition.id };
  });

  const proxyChoices = [
    { value: DIRECT_LINE, label: t('settings.provider.direct') },
    ...(proxyPool?.proxies ?? [])
      .filter((proxy) => proxy.enabled)
      .map((proxy) => ({ value: proxy.id, label: proxy.name })),
  ];

  const submit = async (): Promise<void> => {
    if (saving) return;
    try {
      const trimmedModelId = modelId.trim();
      if (isNewProvider) {
        if (!providerName.trim()) fail('settings.modelForge.providerNameRequired');
        if (providerName.trim().length > 40) fail('settings.modelForge.providerNameTooLong');
        if (!baseUrl.trim()) fail('settings.modelForge.apiUrlRequired');
        if (!/^https?:\/\//i.test(baseUrl.trim())) fail('settings.modelForge.apiUrlInvalid');
        if (spec.keyRequired && !apiKey.trim()) fail('settings.modelForge.apiKeyRequired');
      }
      if (!trimmedModelId) fail(isComfy
        ? 'settings.modelForge.comfyModelIdRequired'
        : 'settings.modelForge.modelIdRequired');
      if (!displayName.trim()) fail('settings.modelForge.displayNameRequired');
      if (provider?.models[trimmedModelId] && trimmedModelId !== editingModelId) {
        fail('settings.modelForge.modelExists', { model: rawText(trimmedModelId) });
      }
      const parsedContext = contextWindow ? Number.parseInt(contextWindow, 10) : undefined;
      if (gateway === 'ai') {
        if (!Number.isFinite(parsedContext)) fail('settings.modelForge.contextRequired');
        if (parsedContext! < MIN_CONTEXT_WINDOW) {
          fail('settings.modelForge.contextMinimum', { minimum: MIN_CONTEXT_WINDOW });
        }
      }

      setSaving(true);
      const targetProviderId = providerId ?? createProviderId();

      // Comfy:组装映射并经主进程校验
      let options: Record<string, unknown> = editingBinding?.options ?? {};
      if (isComfy) {
        const shaped = buildComfyBindings(comfy, candidates, {
          workflowRequired: new PresentationError(messageText('settings.modelForge.workflowRequired')),
          promptMappingRequired: new PresentationError(messageText('settings.modelForge.promptMappingRequired')),
          outputNodeRequired: new PresentationError(messageText('settings.modelForge.outputNodeRequired')),
        });
        const verdict = await window.piskie.inference.validateBindings({
          assetId: comfy.assetId,
          bindings: shaped.bindings,
          outputNodeIds: shaped.outputNodeIds,
        });
        if (!verdict.valid) {
          throw new Error(verdict.issues.map((issue) => issue.message).join('\n'));
        }
        options = {
          workflowAssetId: comfy.assetId,
          bindings: shaped.bindings,
          outputNodeIds: shaped.outputNodeIds,
        };
      }

      // 目录归属:选中定义 → 沿用;既有自定义目录 → 复用;否则铸新自定义目录 id
      const picked = definitions.find((item) => item.id === pickedCatalogId);
      const usePicked = picked !== undefined && pickedWireId === trimmedModelId;
      const reuseCustom = editingBinding?.catalogId.startsWith('custom/') === true;
      const catalogId = usePicked
        ? picked.id
        : reuseCustom
          ? editingBinding.catalogId
          : customCatalogId(targetProviderId, trimmedModelId);
      const inherited = usePicked ? picked : reuseCustom ? editingDefinition : undefined;

      const catalogModel = composeCatalogModel({
        id: catalogId,
        gateway,
        driver: spec.driver,
        draft: {
          displayName,
          contextWindow: parsedContext,
          maxOutputTokens: maxOutput ? Number.parseInt(maxOutput, 10) : undefined,
          tools: tris.tools,
          vision: tris.vision,
          streaming: tris.streaming,
          imageGenerate: tris.imageGenerate,
          imageEdit: tris.imageEdit,
          imageReferenceImages: tris.imageReferenceImages,
          imageMask: tris.imageMask,
          imageSizes,
          imageFormats,
          imageMaxImages: maxImages ? Number.parseInt(maxImages, 10) : undefined,
        },
        comfyOptions: isComfy ? options : undefined,
        existing: inherited,
        reasoningProfile: thinkProfile,
        contextRequiredMessage: new PresentationError(
          messageText('settings.modelForge.composeContextRequired'),
        ),
      });
      if (!picked || !equalCatalogShape(picked, catalogModel)) {
        if (!await upsertCatalogModel(catalogModel)) return;
      }

      const binding: InferenceModelBinding = {
        catalogId,
        upstreamId: trimmedModelId,
        enabled,
        ...(gateway === 'ai' && thinkProfile.mode !== 'none' && thinkPick
          ? { defaultReasoning: thinkPick }
          : {}),
        options,
      };

      let saved: boolean;
      if (isNewProvider) {
        const instance: InferenceProviderInstance = {
          displayName: providerName.trim() || localizedVendorTitle,
          driver: spec.driver,
          enabled: true,
          connection: {
            baseUrl: baseUrl.trim(),
            auth: forgeAuth(spec, apiKey.trim()),
            headers: {},
            proxyId: proxyId !== DIRECT_LINE ? proxyId : null,
          },
          models: { [trimmedModelId]: binding },
          driverOptions: {},
        };
        saved = await addProvider(gateway, targetProviderId, instance, trimmedModelId);
      } else {
        saved = await upsertProviderModel(gateway, targetProviderId, trimmedModelId, binding, editingModelId);
      }
      if (!saved) return;
      onFlash(messageText(editingModelId
        ? 'settings.modelForge.modelUpdated'
        : isNewProvider
          ? 'settings.modelForge.providerAdded'
          : 'settings.modelForge.modelAdded'));
      onSaved(targetProviderId);
      onClose();
    } catch (error) {
      setFault(presentationFromError(
        error,
        messageText('settings.modelForge.operationFailed'),
      ));
    } finally {
      setSaving(false);
    }
  };

  const title = t(editingModelId
    ? gateway === 'ai' ? 'settings.modelForge.editAiModel' : 'settings.modelForge.editImageModel'
    : isComfy ? 'settings.modelForge.addComfyWorkflow' : 'settings.modelForge.addModel');

  return (
    <dialog ref={dialogRef} className={styles.forgeShell} data-wide={isComfy ? 'true' : undefined} aria-label={title}>
      <div className={styles.forgeHead}>
        <span className={styles.brandBox}>
          <BrandMark brand={spec.brand} title={localizedVendorTitle} size={18} />
        </span>
        <span className={styles.forgeTitle}>
          {title}
          <span className={styles.forgeSub}>{localizedVendorTitle} · {localizedVendorBrief}</span>
        </span>
        <button type="button" className={styles.orbBtn} aria-label={t('common.close')} onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <div className={styles.forgeBody}>
        {isNewProvider && (
          <section className={styles.forgeSect}>
            <div className={styles.sectCap}>{t('settings.modelForge.connectionSection')}</div>
            <div className={styles.duoGrid}>
              <div>
                <label className={styles.fieldTag}>{t('settings.modelForge.providerDisplayName')}</label>
                <span className={styles.textIn}>
                  <input
                    value={providerName}
                    maxLength={40}
                    aria-label={t('settings.provider.providerName')}
                    onChange={(event) => {
                      setProviderName(event.target.value);
                      setFault(null);
                    }}
                  />
                </span>
              </div>
              <div>
                <label className={styles.fieldTag}>{t('settings.provider.networkProxy')}</label>
                <DeckSelect
                  ariaLabel={t('settings.provider.networkProxy')}
                  options={proxyChoices}
                  value={proxyId}
                  onPick={setProxyId}
                />
              </div>
            </div>
            <div>
              <label className={styles.fieldTag}>{t('settings.provider.apiUrl')}</label>
              <span className={styles.textIn}>
                <input
                  value={baseUrl}
                  placeholder="https://"
                  aria-label={t('settings.provider.apiUrl')}
                  onChange={(event) => {
                    setBaseUrl(event.target.value);
                    setFault(null);
                  }}
                />
              </span>
            </div>
            {spec.authKind !== 'none' && (
              <div>
                <label className={styles.fieldTag}>
                  {t('settings.provider.apiKey')}{spec.keyRequired ? '' : t('settings.modelForge.optional')}
                </label>
                <span className={`${styles.textIn} ${styles.monoIn}`}>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    placeholder={spec.keyHint}
                    aria-label={t('settings.provider.apiKey')}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setFault(null);
                    }}
                  />
                </span>
              </div>
            )}
          </section>
        )}

        <section className={styles.forgeSect}>
          <div className={styles.sectCap}>{t('settings.modelForge.modelSection')}</div>
          <div className={styles.duoGrid}>
            <div>
              <label className={styles.fieldTag}>{t('settings.modelForge.modelIdHint')}</label>
              <ComboInput
                value={modelId}
                suggestions={suggestions}
                placeholder={t(isComfy
                  ? 'settings.modelForge.modelIdAfterWorkflow'
                  : 'settings.modelForge.modelIdPlaceholder')}
                ariaLabel={t('settings.modelForge.modelId')}
                onChange={(value) => {
                  detachDefinition(value);
                  setFault(null);
                }}
                onAdopt={(item) => {
                  if (item.payload) adoptDefinition(item.value, item.payload);
                }}
              />
            </div>
            <div>
              <label className={styles.fieldTag}>{t('settings.modelForge.displayName')}</label>
              <span className={styles.textIn}>
                <input
                  value={displayName}
                  aria-label={t('settings.modelForge.displayName')}
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                    setNameEdited(true);
                    setFault(null);
                  }}
                />
              </span>
            </div>
          </div>
        </section>

        {gateway === 'ai' && (
          <section className={styles.forgeSect}>
            <div className={styles.sectCap}>{t('settings.modelForge.aiCapabilitiesSection')}</div>
            <div>
              <label className={styles.fieldTag}>{t('settings.modelForge.aiCapabilitiesHint')}</label>
              <div className={styles.trioGrid}>
                {(['tools', 'vision', 'streaming'] as const).map((key) => (
                  <div key={key}>
                    <label className={styles.fieldTag} style={{ margin: '0 0 4px' }}>
                      {t({
                        tools: 'settings.provider.tools',
                        vision: 'settings.provider.vision',
                        streaming: 'settings.provider.streaming',
                      }[key])}
                    </label>
                    <DeckSelect
                      ariaLabel={t({
                        tools: 'settings.provider.tools',
                        vision: 'settings.provider.vision',
                        streaming: 'settings.provider.streaming',
                      }[key])}
                      options={TRI_CHOICES.map((choice) => ({
                        value: choice.value,
                        label: t(choice.labelKey),
                      }))}
                      value={tris[key]}
                      onPick={(value) => setTris((current) => ({ ...current, [key]: value as CapabilityState }))}
                    />
                  </div>
                ))}
              </div>
            </div>

            {transportEditable(spec) && (
              <div>
                <label className={styles.fieldTag}>{t('settings.modelForge.reasoningProtocolHint')}</label>
                <DeckSelect
                  ariaLabel={t('settings.modelForge.reasoningProtocol')}
                  options={TRANSPORT_CHOICES.map((choice) => ({
                    value: choice.value,
                    label: choice.labelKey ? t(choice.labelKey) : choice.label!,
                  }))}
                  value={thinkProfile.transportPreset}
                  onPick={(value) => {
                    const profile = profileForReasoningTransport(value as ReasoningTransportPreset);
                    setThinkProfile(profile);
                    setThinkPick(profile.defaultSelection);
                  }}
                />
              </div>
            )}

            <div>
              <label className={styles.fieldTag}>{t('settings.modelForge.defaultReasoningHint')}</label>
              <ThinkPicker profile={thinkProfile} value={thinkPick} onChange={setThinkPick} />
            </div>

            <div className={styles.sectCap} style={{ marginBlockStart: 4 }}>
              {t('settings.modelForge.limitsSection')}
            </div>
            <div className={styles.duoGrid}>
              <div>
                <label className={styles.fieldTag}>{t('settings.modelForge.contextWindowHint')}</label>
                <span className={styles.textIn}>
                  <input
                    className={styles.monoIn}
                    type="number"
                    min={MIN_CONTEXT_WINDOW}
                    step={1_000}
                    value={contextWindow}
                    aria-label={t('settings.modelForge.contextWindow')}
                    onChange={(event) => {
                      setContextWindow(event.target.value);
                      setFault(null);
                    }}
                  />
                </span>
              </div>
              <div>
                <label className={styles.fieldTag}>{t('settings.modelForge.maxOutputHint')}</label>
                <span className={styles.textIn}>
                  <input
                    className={styles.monoIn}
                    type="number"
                    min={1}
                    step={1_024}
                    value={maxOutput}
                    aria-label={t('settings.modelForge.maxOutput')}
                    onChange={(event) => setMaxOutput(event.target.value)}
                  />
                </span>
              </div>
            </div>
          </section>
        )}

        {gateway === 'image' && !isComfy && (
          <section className={styles.forgeSect}>
            <div className={styles.sectCap}>{t('settings.modelForge.imageCapabilitiesSection')}</div>
            <div>
              <label className={styles.fieldTag}>{t('settings.modelForge.imageCapabilitiesHint')}</label>
              <div className={styles.duoGrid}>
                {(['imageGenerate', 'imageEdit', 'imageReferenceImages', 'imageMask'] as const).map((key) => (
                  <div key={key}>
                    <label className={styles.fieldTag} style={{ margin: '0 0 4px' }}>
                      {t({
                        imageGenerate: 'settings.provider.generate',
                        imageEdit: 'settings.provider.editImage',
                        imageReferenceImages: 'settings.provider.referenceImages',
                        imageMask: 'settings.provider.mask',
                      }[key])}
                    </label>
                    <DeckSelect
                      ariaLabel={t({
                        imageGenerate: 'settings.provider.generate',
                        imageEdit: 'settings.provider.editImage',
                        imageReferenceImages: 'settings.provider.referenceImages',
                        imageMask: 'settings.provider.mask',
                      }[key])}
                      options={TRI_CHOICES.map((choice) => ({
                        value: choice.value,
                        label: t(choice.labelKey),
                      }))}
                      value={tris[key]}
                      onPick={(value) => setTris((current) => ({ ...current, [key]: value as CapabilityState }))}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <label className={styles.fieldTag}>{t('settings.modelForge.sizeHint')}</label>
              <div className={styles.tagField}>
                {imageSizes.map((size) => (
                  <span key={size} className={styles.tagBead}>
                    {size}
                    <button
                      type="button"
                      aria-label={t('settings.modelForge.removeSize', { size })}
                      onClick={() => setImageSizes((current) => current.filter((item) => item !== size))}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                <input
                  value={sizeDraft}
                  aria-label={t('settings.modelForge.addSize')}
                  onChange={(event) => setSizeDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ',' && event.key !== ' ') return;
                    event.preventDefault();
                    const next = sizeDraft.trim();
                    if (next && !imageSizes.includes(next)) setImageSizes((current) => [...current, next]);
                    setSizeDraft('');
                  }}
                />
              </div>
            </div>

            <div className={styles.duoGrid}>
              <div>
                <label className={styles.fieldTag}>{t('settings.modelForge.formatHint')}</label>
                <span className={styles.lever} role="group" aria-label={t('settings.modelForge.outputFormat')}>
                  {IMAGE_FORMATS.map((format) => (
                    <button
                      key={format}
                      type="button"
                      data-on={imageFormats.includes(format)}
                      onClick={() => setImageFormats((current) => (
                        current.includes(format)
                          ? current.filter((item) => item !== format)
                          : [...current, format]
                      ))}
                    >
                      {format}
                    </button>
                  ))}
                </span>
              </div>
              <div>
                <label className={styles.fieldTag}>{t('settings.modelForge.maxImagesHint')}</label>
                <span className={styles.textIn}>
                  <input
                    className={styles.monoIn}
                    type="number"
                    min={1}
                    value={maxImages}
                    aria-label={t('settings.modelForge.maxImages')}
                    onChange={(event) => setMaxImages(event.target.value)}
                  />
                </span>
              </div>
            </div>
          </section>
        )}

        {isComfy && (
          <section className={styles.forgeSect}>
            <div className={styles.sectCap}>{t('settings.modelForge.workflowSection')}</div>
            <ComfyRig
              draft={comfy}
              candidates={candidates}
              busy={comfyBusy}
              dragOver={dragOver}
              onDragOver={setDragOver}
              onChange={setComfy}
              onImport={(file) => void importWorkflow(file)}
            />
          </section>
        )}
      </div>

      <div className={styles.forgeFoot}>
        <Toggle on={enabled} ariaLabel={t('settings.modelForge.enableModel')} onFlip={setEnabled} />
        <span style={{ fontSize: 12 }}>{t('settings.modelForge.enabled')}</span>
        <span className={styles.footHint}>
          {faultText ? <span className={styles.faultNote}>{faultText}</span> : null}
        </span>
        <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} disabled={saving} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrime}`}
          disabled={saving || comfyBusy}
          onClick={() => void submit()}
        >
          {saving
            ? t('settings.modelForge.saving')
            : editingModelId
              ? t('settings.modelForge.save')
              : t('settings.modelForge.addModel')}
        </button>
      </div>
    </dialog>
  );
};

/** 默认思考程度选择:radio 组 + budget 时的 token 预算输入 */
function ThinkPicker({
  profile,
  value,
  onChange,
}: {
  readonly profile: ReasoningProfile;
  readonly value?: ReasoningSelection;
  readonly onChange: (value?: ReasoningSelection) => void;
}) {
  const { t } = useTranslation();
  const requested = value ?? profile.defaultSelection;
  const resolved = profile.mode === 'none'
    ? undefined
    : resolveSelectableReasoning(profile, requested);
  const options = getSelectableReasoningOptions(profile);

  // 请求值不可选时贴合到可选项(协议切换后的自愈)
  useEffect(() => {
    if (!resolved || reasoningOptionKey(requested) === reasoningOptionKey(resolved)) return;
    onChange(resolved);
  }, [onChange, requested, resolved]);

  if (!resolved || options.length === 0) {
    return <div className={styles.fieldNote}>{t('settings.modelForge.noReasoningOptions')}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className={styles.reasonRack} role="radiogroup" aria-label={t('settings.modelForge.defaultReasoningAria')}>
        {options.map((option) => {
          const key = reasoningOptionKey(option);
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={key === reasoningOptionKey(resolved)}
              className={styles.reasonPick}
              onClick={() => onChange(option)}
            >
              {reasoningSelectionLabel(option, false, t)}
            </button>
          );
        })}
      </div>
      {resolved.kind === 'budget' && (
        <span className={styles.textIn} style={{ maxInlineSize: 220 }}>
          <input
            className={styles.monoIn}
            type="number"
            min={profile.minBudgetTokens ?? 1}
            max={profile.maxBudgetTokens}
            step={1_024}
            value={resolved.tokens}
            aria-label={t('settings.modelForge.reasoningBudget')}
            onChange={(event) => {
              const tokens = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(tokens) && tokens > 0) onChange({ kind: 'budget', tokens });
            }}
          />
          <span className={styles.inMiniBtn} aria-hidden>tokens</span>
        </span>
      )}
    </div>
  );
}

/** ComfyUI 工作流配置区:导入 + 字段映射 + 输出节点 */
function ComfyRig({
  draft,
  candidates,
  busy,
  dragOver,
  onDragOver,
  onChange,
  onImport,
}: {
  readonly draft: ComfyDraft;
  readonly candidates: InferenceComfyWorkflowBindingCandidates | undefined;
  readonly busy: boolean;
  readonly dragOver: boolean;
  readonly onDragOver: (over: boolean) => void;
  readonly onChange: (draft: ComfyDraft) => void;
  readonly onImport: (file: File) => void;
}) {
  const { t } = useTranslation();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const NONE = '__none__';

  const bindChoices = (options: readonly { nodeId: string; field: string }[], required: boolean) => [
    ...(required ? [] : [{ value: NONE, label: t('settings.modelForge.noMapping') }]),
    ...options.map((binding) => ({
      value: `${binding.nodeId}::${binding.field}`,
      label: `${binding.nodeId}.${binding.field}`,
    })),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        className={styles.dropZone}
        data-over={dragOver}
        role="button"
        tabIndex={0}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          onDragOver(true);
        }}
        onDragLeave={() => onDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          onDragOver(false);
          const file = event.dataTransfer.files[0];
          if (file) onImport(file);
        }}
      >
        <UploadCloud size={18} style={{ opacity: 0.7 }} />
        <div>{busy ? t('settings.modelForge.parsingWorkflow') : t('settings.modelForge.workflowDrop')}</div>
        <small>{t('settings.modelForge.workflowVersionHint')}</small>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onImport(file);
            event.target.value = '';
          }}
        />
      </div>

      {draft.assetId && (
        <div className={styles.assetTag}>
          {t('settings.modelForge.loadedAsset', { asset: draft.assetId.slice(0, 31) })}
        </div>
      )}

      {draft.inspection && candidates && (
        <div className={styles.duoGrid}>
          <div>
            <label className={styles.fieldTag}>{t('settings.modelForge.promptNodeRequired')}</label>
            <DeckSelect
              ariaLabel={t('settings.modelForge.promptNode')}
              options={bindChoices(candidates.prompt, true)}
              value={draft.prompt}
              placeholder={t(candidates.prompt.length > 0
                ? 'settings.modelForge.selectMapping'
                : 'settings.modelForge.noCandidates')}
              onPick={(value) => onChange({ ...draft, prompt: value })}
            />
          </div>
          {([
            ['seed', t('settings.modelForge.seed'), candidates.seed],
            ['width', t('settings.modelForge.width'), candidates.width],
            ['height', t('settings.modelForge.height'), candidates.height],
            ['batch', t('settings.modelForge.batch'), candidates.batch],
          ] as const).map(([key, label, options]) => (
            <div key={key}>
              <label className={styles.fieldTag}>{label}</label>
              <DeckSelect
                ariaLabel={label}
                options={bindChoices(options, false)}
                value={draft[key] ?? NONE}
                placeholder={t(options.length > 0
                  ? 'settings.modelForge.selectMapping'
                  : 'settings.modelForge.noCandidates')}
                onPick={(value) => onChange({ ...draft, [key]: value === NONE ? undefined : value })}
              />
            </div>
          ))}
          <div style={{ gridColumn: 'span 2' }}>
            <label className={styles.fieldTag}>{t('settings.modelForge.outputNodes')}</label>
            <div className={styles.reasonRack}>
              {draft.inspection.nodes.map((node) => (
                <button
                  key={node.nodeId}
                  type="button"
                  className={styles.reasonPick}
                  aria-checked={draft.outputNodeIds.includes(node.nodeId)}
                  role="checkbox"
                  onClick={() => onChange({
                    ...draft,
                    outputNodeIds: draft.outputNodeIds.includes(node.nodeId)
                      ? draft.outputNodeIds.filter((id) => id !== node.nodeId)
                      : [...draft.outputNodeIds, node.nodeId],
                  })}
                >
                  {node.nodeId} · {node.title ?? node.classType}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
