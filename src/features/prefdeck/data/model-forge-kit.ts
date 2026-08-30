/**
 * 模型编辑的纯函数工具箱（重写）。
 *
 * 目录模型组装、等价判定(避免无谓的目录写入)、线上模型 ID 推导、
 * ComfyUI 字段映射的封/解与草稿还原。全部纯函数,IPC 校验留在组件层。
 */

import type { CapabilityState } from '../../../../shared/types/model-catalog';
import type { ReasoningProfile } from '../../../../shared/types/reasoning';
import type {
  InferenceCatalogModelInput,
  InferenceComfyFieldBinding,
  InferenceComfyWorkflowInspection,
  InferenceModelBinding,
  InferenceModelCapabilities,
  InferenceModelDefinition,
} from '../../../../shared/types/inference';
import type { GatewayKind } from './vendor-atlas';
import { recordOf } from './record-shape';

/* ── 能力三态 ── */

export function triOf(value: boolean | undefined): CapabilityState {
  if (value === undefined) return 'unknown';
  return value ? 'supported' : 'unsupported';
}

function boolOf(state: CapabilityState | undefined): boolean | undefined {
  if (state === 'supported') return true;
  if (state === 'unsupported') return false;
  return undefined;
}

function squeeze(values: Record<string, boolean | undefined>): InferenceModelCapabilities {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, boolean] => entry[1] !== undefined),
  );
}

/* ── 目录模型组装 ── */

export interface CatalogDraft {
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  tools: CapabilityState;
  vision: CapabilityState;
  streaming: CapabilityState;
  imageGenerate: CapabilityState;
  imageEdit: CapabilityState;
  imageReferenceImages: CapabilityState;
  imageMask: CapabilityState;
  imageSizes?: string[];
  imageFormats?: Array<'png' | 'jpeg' | 'webp'>;
  imageMaxImages?: number;
}

export function composeCatalogModel(args: {
  id: string;
  gateway: GatewayKind;
  driver: string;
  draft: CatalogDraft;
  comfyOptions?: Record<string, unknown>;
  existing?: InferenceModelDefinition;
  reasoningProfile: ReasoningProfile;
  contextRequiredMessage: string | Error;
}): InferenceCatalogModelInput {
  const {
    id,
    gateway,
    driver,
    draft,
    comfyOptions,
    existing,
    reasoningProfile,
    contextRequiredMessage,
  } = args;
  if (gateway === 'ai' && draft.contextWindow === undefined) {
    if (contextRequiredMessage instanceof Error) throw contextRequiredMessage;
    throw new Error(contextRequiredMessage);
  }

  const capabilities: InferenceModelCapabilities = gateway === 'ai'
    ? squeeze({
        tools: boolOf(draft.tools),
        vision: boolOf(draft.vision),
        streaming: boolOf(draft.streaming),
        reasoning: reasoningProfile.mode !== 'none',
        structuredOutput: existing?.capabilities.structuredOutput,
      })
    : comfyOptions
      ? {
          generate: true,
          edit: hasImageInputs(comfyOptions),
          referenceImages: hasImageInputs(comfyOptions),
          mask: hasMaskInput(comfyOptions),
        }
      : squeeze({
          generate: boolOf(draft.imageGenerate),
          edit: boolOf(draft.imageEdit),
          referenceImages: boolOf(draft.imageReferenceImages),
          mask: boolOf(draft.imageMask),
        });

  const takesImages = gateway === 'ai'
    ? capabilities.vision === true
    : capabilities.edit === true || capabilities.referenceImages === true || capabilities.mask === true;

  return {
    id,
    displayName: draft.displayName.trim(),
    kind: gateway,
    ...(existing?.family && { family: existing.family }),
    ...(existing?.releaseDate && { releaseDate: existing.releaseDate }),
    lifecycle: existing?.lifecycle ?? 'active',
    compatibleDrivers: [...new Set([...(existing?.compatibleDrivers ?? []), driver])],
    inputModalities: ['text', ...(takesImages ? ['image'] : [])],
    outputModalities: [gateway === 'ai' ? 'text' : 'image'],
    capabilities,
    ...(gateway === 'ai' && { reasoning: reasoningProfile }),
    limits: {
      ...(gateway === 'ai' && { contextWindow: draft.contextWindow! }),
      ...(draft.maxOutputTokens ? { maxOutputTokens: draft.maxOutputTokens } : {}),
      ...(gateway === 'image' && draft.imageMaxImages ? { maxImages: draft.imageMaxImages } : {}),
      ...(gateway === 'image' && draft.imageSizes?.length
        ? { sizes: dedupeStrings(draft.imageSizes) }
        : {}),
      ...(gateway === 'image' && draft.imageFormats?.length
        ? { formats: [...new Set(draft.imageFormats)] }
        : {}),
    },
    ...(existing?.pricing && { pricing: existing.pricing }),
  };
}

/** 与目录内既有定义等价(忽略 source/operationCapability)→ 跳过目录写入 */
export function equalCatalogShape(
  definition: InferenceModelDefinition,
  model: InferenceCatalogModelInput,
): boolean {
  const shape = { ...definition } as Record<string, unknown>;
  delete shape.source;
  delete shape.operationCapability;
  return canonJson(shape) === canonJson(model);
}

function canonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonJson).join(',')}]`;
  const record = recordOf(value);
  if (record) {
    return `{${Object.entries(record)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 目录定义 → 发给上游的模型 ID(剥掉 family 前缀) */
export function wireIdOf(definition: InferenceModelDefinition): string {
  const prefix = definition.family ? `${definition.family}/` : '';
  return prefix && definition.id.startsWith(prefix) ? definition.id.slice(prefix.length) : definition.id;
}

/** 目录排序:发布日期新→旧,再按目录更新时间,再按 id */
export function freshFirst(
  left: InferenceModelDefinition,
  right: InferenceModelDefinition,
): number {
  if (left.releaseDate && right.releaseDate && left.releaseDate !== right.releaseDate) {
    return right.releaseDate.localeCompare(left.releaseDate);
  }
  if (left.releaseDate) return -1;
  if (right.releaseDate) return 1;
  if (left.source.updatedAt && right.source.updatedAt && left.source.updatedAt !== right.source.updatedAt) {
    return right.source.updatedAt.localeCompare(left.source.updatedAt);
  }
  if (left.source.updatedAt) return -1;
  if (right.source.updatedAt) return 1;
  return left.id.localeCompare(right.id);
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/* ── ComfyUI 字段映射 ── */

export interface ComfyDraft {
  assetId: string;
  inspection?: InferenceComfyWorkflowInspection;
  prompt?: string;
  seed?: string;
  width?: string;
  height?: string;
  batch?: string;
  outputNodeIds: string[];
  /** 表单未展示的既有 bindings(inputImages/mask 等)原样保留 */
  preservedBindings: Record<string, unknown>;
}

export const BLANK_COMFY: ComfyDraft = { assetId: '', outputNodeIds: [], preservedBindings: {} };

/** nodeId::field 封成下拉值 */
export function sealBinding(binding?: InferenceComfyFieldBinding): string | undefined {
  return binding ? `${binding.nodeId}::${binding.field}` : undefined;
}

export function unsealBinding(value?: string): InferenceComfyFieldBinding | undefined {
  if (!value) return undefined;
  const cut = value.indexOf('::');
  if (cut <= 0 || cut === value.length - 2) return undefined;
  return { nodeId: value.slice(0, cut), field: value.slice(cut + 2) };
}

function asFieldBinding(value: unknown): InferenceComfyFieldBinding | undefined {
  const field = recordOf(value);
  if (!field || typeof field.nodeId !== 'string' || typeof field.field !== 'string') return undefined;
  return { nodeId: field.nodeId, field: field.field };
}

/** 从既有绑定还原 Comfy 草稿 */
export function comfyDraftOf(binding?: InferenceModelBinding): ComfyDraft {
  const options = binding?.options;
  if (!options || typeof options.workflowAssetId !== 'string') return BLANK_COMFY;
  const raw = recordOf(options.bindings) ?? {};
  return {
    assetId: options.workflowAssetId,
    prompt: sealBinding(asFieldBinding(raw.prompt)),
    seed: sealBinding(asFieldBinding(raw.seed)),
    width: sealBinding(asFieldBinding(raw.width)),
    height: sealBinding(asFieldBinding(raw.height)),
    batch: sealBinding(asFieldBinding(raw.batch)),
    outputNodeIds: Array.isArray(options.outputNodeIds)
      ? options.outputNodeIds.filter((item): item is string => typeof item === 'string')
      : [],
    preservedBindings: raw,
  };
}

/** save/preview/output 类节点优先,否则末节点兜底 */
export function suggestOutputNodes(inspection: InferenceComfyWorkflowInspection): string[] {
  const likely = inspection.nodes.filter((node) => (
    /save|preview|output/i.test(`${node.classType} ${node.title ?? ''}`)
  ));
  return (likely.length > 0 ? likely : inspection.nodes.slice(-1)).map((node) => node.nodeId);
}

export interface ComfyCandidatesLike {
  readonly inputImages: readonly InferenceComfyFieldBinding[];
  readonly mask: readonly InferenceComfyFieldBinding[];
}

/**
 * 草稿 → 待校验的 bindings + outputNodeIds(提示词必选、至少一个输出节点);
 * inputImages/mask 未被表单覆盖时采用检测到的首个候选。
 */
export function buildComfyBindings(
  draft: ComfyDraft,
  candidates: ComfyCandidatesLike | undefined,
  messages: {
    readonly workflowRequired: string | Error;
    readonly promptMappingRequired: string | Error;
    readonly outputNodeRequired: string | Error;
  },
): { bindings: Record<string, unknown>; outputNodeIds: string[] } {
  if (!draft.assetId) throwValidation(messages.workflowRequired);
  const prompt = unsealBinding(draft.prompt);
  if (!prompt) throwValidation(messages.promptMappingRequired);
  if (draft.outputNodeIds.length === 0) throwValidation(messages.outputNodeRequired);

  const bindings: Record<string, unknown> = {
    ...draft.preservedBindings,
    prompt,
    ...(unsealBinding(draft.seed) && { seed: unsealBinding(draft.seed) }),
    ...(unsealBinding(draft.width) && { width: unsealBinding(draft.width) }),
    ...(unsealBinding(draft.height) && { height: unsealBinding(draft.height) }),
    ...(unsealBinding(draft.batch) && { batch: unsealBinding(draft.batch) }),
  };
  if (!bindings.inputImages && candidates?.inputImages[0]) {
    bindings.inputImages = [candidates.inputImages[0]];
  }
  if (!bindings.mask && candidates?.mask[0]) bindings.mask = candidates.mask[0];

  return { bindings, outputNodeIds: draft.outputNodeIds };
}

function throwValidation(failure: string | Error): never {
  throw failure instanceof Error ? failure : new Error(failure);
}

function hasImageInputs(options: Record<string, unknown>): boolean {
  const bindings = recordOf(options.bindings);
  return !!bindings && Array.isArray(bindings.inputImages) && bindings.inputImages.length > 0;
}

function hasMaskInput(options: Record<string, unknown>): boolean {
  return recordOf(recordOf(options.bindings)?.mask) !== undefined;
}
