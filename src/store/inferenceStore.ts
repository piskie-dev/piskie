import { createUuid } from '@shared/utils/identifiers.js';
import { create } from 'zustand';
import type {
  InferenceAvailableTarget,
  InferenceCatalogModelInput,
  InferenceArtifactPreview,
  InferenceConfig,
  InferenceDriverSummary,
  InferenceLocalCatalogDocument,
  InferenceModelBinding,
  InferenceModelDefinition,
  InferenceProbeReceipt,
  InferenceProviderInstance,
  InferenceSelections,
  ModelTarget,
} from '../../shared/types/inference';
import type {
  InferenceConnectionUpdate,
} from '../../shared/electron-contracts/configuration';
import type { ConfigDescriptor } from '../../shared/types/config';
import type { ReasoningSelection } from '../../shared/types/reasoning';
import {
  messageText,
  PresentationError,
  rawText,
  type PresentationText,
  type PresentationValue,
} from '../i18n/presentationText';
import {
  applyConfigFieldChanges,
  type ConfigFieldMutation,
} from '../features/config/config-transaction';
import { subscribeToConfigDomainRevisions } from '../features/config/domain-revision-sync';

export type InferenceGatewayKind = 'ai' | 'image';

export interface ModelOptGroup {
  label: string;
  options: Array<{
    label: string;
    value: string;
    target: ModelTarget;
    definition: InferenceModelDefinition;
    defaultReasoning?: ReasoningSelection;
  }>;
}

type ProviderUpdates = Partial<Omit<InferenceProviderInstance, 'connection'>> & {
  connection?: InferenceConnectionUpdate;
};
type InferenceConfigDomain = 'inference' | 'inference-selections' | 'model-catalog';
type InferenceDomainDescriptors = Record<InferenceConfigDomain, ConfigDescriptor>;

interface ModelCatalogConfigDocument {
  revision: number;
  version: string;
  models: Record<string, Partial<Omit<InferenceModelDefinition, 'id'>>>;
}

interface InferenceState {
  config: InferenceConfig | null;
  descriptors: InferenceDomainDescriptors | null;
  localCatalog: InferenceLocalCatalogDocument | null;
  selections: InferenceSelections | null;
  drivers: InferenceDriverSummary[];
  models: Record<InferenceGatewayKind, InferenceModelDefinition[]>;
  availableTargets: Record<InferenceGatewayKind, InferenceAvailableTarget[]>;
  isLoading: boolean;
  isApplying: boolean;
  error: PresentationText | null;
  refresh: () => Promise<void>;
  subscribeToConfigChanges: () => () => void;
  addProvider: (
    gateway: InferenceGatewayKind,
    providerId: string,
    provider: InferenceProviderInstance,
    modelId: string,
  ) => Promise<boolean>;
  updateProvider: (providerId: string, updates: ProviderUpdates) => Promise<boolean>;
  removeProvider: (providerId: string) => Promise<boolean>;
  upsertProviderModel: (
    gateway: InferenceGatewayKind,
    providerId: string,
    modelId: string,
    binding: InferenceModelBinding,
    previousModelId?: string,
  ) => Promise<boolean>;
  removeProviderModel: (
    gateway: InferenceGatewayKind,
    providerId: string,
    modelId: string,
  ) => Promise<boolean>;
  updatePolicies: (
    gateway: InferenceGatewayKind,
    updates: Partial<InferenceConfig['policies'][InferenceGatewayKind]>,
  ) => Promise<boolean>;
  updateModelReasoningDefault: (
    modelReference: string,
    selection: ReasoningSelection,
  ) => Promise<boolean>;
  updateSelection: (kind: InferenceGatewayKind, target: ModelTarget | null) => Promise<boolean>;
  upsertCatalogModel: (model: InferenceCatalogModelInput) => Promise<boolean>;
  removeCatalogModel: (modelId: string) => Promise<boolean>;
  probe: (
    level: 'connectivity' | 'smoke',
    target?: Partial<ModelTarget>,
  ) => Promise<InferenceProbeReceipt[] | null>;
  readArtifact: (artifactId: string) => Promise<InferenceArtifactPreview | null>;
  clearError: () => void;
}

type StoreSet = (partial: Partial<InferenceState>) => void;
type StoreGet = () => InferenceState;

let mutationTail: Promise<void> = Promise.resolve();
let pendingMutations = 0;
let refreshInFlight: Promise<void> | null = null;

function productError(
  key: string,
  values?: Readonly<Record<string, PresentationValue>>,
): PresentationError {
  return new PresentationError(messageText(key, values));
}

function mutationError(error: unknown): PresentationText {
  if (error instanceof PresentationError) return error.presentation;
  return rawText(error instanceof Error ? error.message : String(error));
}

function serializeMutation(set: StoreSet, operation: () => Promise<boolean>): Promise<boolean> {
  pendingMutations += 1;
  set({ isApplying: true, error: null });

  let resolveResult: (result: boolean) => void;
  const result = new Promise<boolean>((resolve) => {
    resolveResult = resolve;
  });
  mutationTail = mutationTail
    .then(async () => {
      try {
        resolveResult(await operation());
      } catch (error) {
        set({ error: mutationError(error) });
        resolveResult(false);
      } finally {
        pendingMutations -= 1;
        if (pendingMutations === 0) set({ isApplying: false });
      }
    })
    .catch(() => undefined);
  return result;
}

async function refreshState(set: StoreSet): Promise<void> {
  const [
    config,
    inferenceDescriptor,
    selections,
    selectionsDescriptor,
    catalog,
    catalogDescriptor,
    drivers,
    aiModels,
    imageModels,
  ] = await Promise.all([
    window.piskie.configuration.read<InferenceConfig>('inference'),
    window.piskie.configuration.describe('inference'),
    window.piskie.configuration.read<InferenceSelections>('inference-selections'),
    window.piskie.configuration.describe('inference-selections'),
    window.piskie.configuration.read<ModelCatalogConfigDocument>('model-catalog'),
    window.piskie.configuration.describe('model-catalog'),
    window.piskie.inference.listDrivers(),
    window.piskie.inference.queryModels({ gateway: 'ai' }),
    window.piskie.inference.queryModels({ gateway: 'image' }),
  ]);
  set({
    config,
    descriptors: {
      inference: inferenceDescriptor,
      'inference-selections': selectionsDescriptor,
      'model-catalog': catalogDescriptor,
    },
    localCatalog: toLocalCatalog(catalog),
    selections,
    drivers,
    models: { ai: aiModels.models, image: imageModels.models },
    availableTargets: {
      ai: aiModels.availableTargets,
      image: imageModels.availableTargets,
    },
    error: null,
  });
}

async function refreshStateCoalesced(set: StoreSet): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  const task = refreshState(set);
  refreshInFlight = task;
  try {
    await task;
  } finally {
    if (refreshInFlight === task) refreshInFlight = null;
  }
}

async function commitChanges(
  get: StoreGet,
  set: StoreSet,
  domain: InferenceConfigDomain,
  expectedRevision: number,
  changes: readonly ConfigFieldMutation[],
): Promise<void> {
  if (changes.length === 0) return;
  const descriptor = get().descriptors?.[domain];
  if (!descriptor) {
    throw productError('settings.inferenceFailure.descriptorUnavailable', {
      domain: rawText(domain),
    });
  }
  const { receipt } = await applyConfigFieldChanges(domain, descriptor, expectedRevision, changes);
  await refreshStateCoalesced(set);
  if (domainRevision(get(), domain) !== receipt.revision) {
    await refreshStateCoalesced(set);
  }
  if (domainRevision(get(), domain) !== receipt.revision) {
    throw productError('settings.inferenceFailure.revisionNotReached', {
      domain: rawText(domain),
      revision: receipt.revision,
    });
  }
  if (get().error) throw new PresentationError(get().error!);
}

function domainRevision(state: InferenceState, domain: InferenceConfigDomain): number | undefined {
  if (domain === 'inference') return state.config?.revision;
  if (domain === 'inference-selections') return state.selections?.revision;
  return state.localCatalog?.revision;
}

async function persistSelection(
  get: StoreGet,
  set: StoreSet,
  kind: InferenceGatewayKind,
  target: ModelTarget | null,
): Promise<void> {
  const current = get().selections;
  if (!current) throw productError('settings.inferenceFailure.selectionUnavailable');
  const selected = current[kind];
  if ((!target && !selected)
    || (target && selected?.providerId === target.providerId && selected.modelId === target.modelId)) {
    return;
  }
  await commitChanges(get, set, 'inference-selections', current.revision, [target
    ? { op: 'set', pathTemplate: `/${kind}`, value: target }
    : { op: 'remove', pathTemplate: `/${kind}` }]);
}

function toLocalCatalog(catalog: ModelCatalogConfigDocument): InferenceLocalCatalogDocument {
  return {
    revision: catalog.revision,
    version: catalog.version,
    models: Object.entries(catalog.models).map(([id, model]) => ({ id, ...model })),
  };
}

async function clearMatchingSelections(
  get: StoreGet,
  set: StoreSet,
  matches: (target: ModelTarget) => boolean,
): Promise<void> {
  for (const gateway of ['ai', 'image'] as const) {
    const target = get().selections?.[gateway];
    if (target && matches(target)) await persistSelection(get, set, gateway, null);
  }
}

async function selectTargetWhenUnset(
  get: StoreGet,
  set: StoreSet,
  gateway: InferenceGatewayKind,
  target: ModelTarget,
): Promise<void> {
  if (get().selections?.[gateway]) return;
  const provider = get().config?.providers[target.providerId];
  if (!provider?.enabled || !provider.models[target.modelId]?.enabled) return;
  await persistSelection(get, set, gateway, target);
}

export const useInferenceStore = create<InferenceState>((set, get) => ({
  config: null,
  descriptors: null,
  localCatalog: null,
  selections: null,
  drivers: [],
  models: { ai: [], image: [] },
  availableTargets: { ai: [], image: [] },
  isLoading: false,
  isApplying: false,
  error: null,

  refresh: async () => {
    set({ isLoading: true, error: null });
    try {
      await refreshStateCoalesced(set);
    } catch (error) {
      set({ error: mutationError(error) });
    } finally {
      set({ isLoading: false });
    }
  },

  subscribeToConfigChanges: () => subscribeToConfigDomainRevisions({
    domain: 'inference',
    subscribe: (listener) => window.piskie.configuration.observeChanges(listener),
    getSnapshot: () => ({
      revision: get().config?.revision,
      descriptorHash: get().descriptors?.inference.descriptorHash,
    }),
    refresh: () => refreshStateCoalesced(set),
    onError: (error) => set({ error: mutationError(error) }),
  }),

  addProvider: (gateway, providerId, provider, modelId) => serializeMutation(set, async () => {
    const current = get().config;
    if (!current) throw productError('settings.inferenceFailure.configUnavailable');
    await commitChanges(get, set, 'inference', current.revision, [{
      op: 'set',
      pathTemplate: '/providers/{providerId}',
      bindings: { providerId },
      value: provider,
    }]);
    await selectTargetWhenUnset(get, set, gateway, { providerId, modelId });
    return true;
  }),

  updateProvider: (providerId, updates) => serializeMutation(set, async () => {
    const config = get().config;
    if (!config?.providers[providerId]) {
      throw productError('settings.inferenceFailure.providerMissing', {
        provider: rawText(providerId),
      });
    }
    const changes = Object.entries(updates).flatMap(([field, value]): ConfigFieldMutation[] => {
      if (value === undefined) return [];
      if (field !== 'connection') {
        return [{
          op: 'set',
          pathTemplate: `/providers/{providerId}/${field}`,
          bindings: { providerId },
          value,
        }];
      }
      return Object.entries(value as InferenceConnectionUpdate).flatMap(
        ([connectionField, connectionValue]): ConfigFieldMutation[] => connectionValue === undefined
          ? []
          : [{
              op: 'set',
              pathTemplate: `/providers/{providerId}/connection/${connectionField}`,
              bindings: { providerId },
              value: connectionValue,
            }],
      );
    });
    await commitChanges(get, set, 'inference', config.revision, changes);
    if (updates.enabled === false) {
      await clearMatchingSelections(get, set, (target) => target.providerId === providerId);
    }
    return true;
  }),

  removeProvider: (providerId) => serializeMutation(set, async () => {
    const config = get().config;
    if (!config?.providers[providerId]) {
      throw productError('settings.inferenceFailure.providerMissing', {
        provider: rawText(providerId),
      });
    }
    await clearMatchingSelections(get, set, (target) => target.providerId === providerId);
    const refreshed = get().config;
    if (!refreshed?.providers[providerId]) return true;
    await commitChanges(get, set, 'inference', refreshed.revision, [{
      op: 'remove',
      pathTemplate: '/providers/{providerId}',
      bindings: { providerId },
    }]);
    return true;
  }),

  upsertProviderModel: (
    gateway,
    providerId,
    modelId,
    binding,
    previousModelId,
  ) => serializeMutation(set, async () => {
    const config = get().config;
    const provider = config?.providers[providerId];
    if (!config || !provider) {
      throw productError('settings.inferenceFailure.providerMissing', {
        provider: rawText(providerId),
      });
    }
    const priorId = previousModelId ?? modelId;
    const selected = get().selections?.[gateway];
    const selectedPrior = selected?.providerId === providerId && selected.modelId === priorId;
    if (priorId !== modelId && selectedPrior) {
      await persistSelection(get, set, gateway, null);
    }

    const refreshed = get().config;
    const refreshedProvider = refreshed?.providers[providerId];
    if (!refreshed || !refreshedProvider) {
      throw productError('settings.inferenceFailure.providerMissing', {
        provider: rawText(providerId),
      });
    }
    const changes: ConfigFieldMutation[] = [];
    if (priorId !== modelId && refreshedProvider.models[priorId]) {
      changes.push({
        op: 'remove',
        pathTemplate: '/providers/{providerId}/models/{modelId}',
        bindings: { providerId, modelId: priorId },
      });
    }
    changes.push({
      op: 'set',
      pathTemplate: '/providers/{providerId}/models/{modelId}',
      bindings: { providerId, modelId },
      value: binding,
    });
    await commitChanges(get, set, 'inference', refreshed.revision, changes);

    if (selectedPrior) {
      await persistSelection(
        get,
        set,
        gateway,
        binding.enabled && get().config?.providers[providerId]?.enabled
          ? { providerId, modelId }
          : null,
      );
    } else if (!binding.enabled
      && selected?.providerId === providerId
      && selected.modelId === modelId) {
      await persistSelection(get, set, gateway, null);
    }
    await selectTargetWhenUnset(get, set, gateway, { providerId, modelId });
    return true;
  }),

  removeProviderModel: (gateway, providerId, modelId) => serializeMutation(set, async () => {
    const config = get().config;
    if (!config?.providers[providerId]?.models[modelId]) {
      throw productError('settings.inferenceFailure.modelBindingMissing', {
        provider: rawText(providerId),
        model: rawText(modelId),
      });
    }
    const selected = get().selections?.[gateway];
    if (selected?.providerId === providerId && selected.modelId === modelId) {
      await persistSelection(get, set, gateway, null);
    }
    const refreshed = get().config;
    if (!refreshed?.providers[providerId]?.models[modelId]) return true;
    await commitChanges(get, set, 'inference', refreshed.revision, [{
      op: 'remove',
      pathTemplate: '/providers/{providerId}/models/{modelId}',
      bindings: { providerId, modelId },
    }]);
    return true;
  }),

  updatePolicies: (gateway, updates) => serializeMutation(set, async () => {
    const config = get().config;
    if (!config) throw productError('settings.inferenceFailure.configUnavailable');
    const changes = Object.entries(updates).flatMap(([field, value]): ConfigFieldMutation[] => value === undefined
      ? []
      : [{ op: 'set', pathTemplate: `/policies/${gateway}/${field}`, value }]);
    await commitChanges(get, set, 'inference', config.revision, changes);
    return true;
  }),

  updateModelReasoningDefault: (modelReference, selection) => serializeMutation(set, async () => {
    const target = parseModelReference(modelReference);
    if (!target) {
      throw productError('settings.inferenceFailure.modelReferenceInvalid', {
        reference: rawText(modelReference),
      });
    }
    const binding = get().config?.providers[target.providerId]?.models[target.modelId];
    if (!binding) {
      throw productError('settings.inferenceFailure.modelBindingMissing', {
        provider: rawText(target.providerId),
        model: rawText(target.modelId),
      });
    }
    if (sameReasoningSelection(binding.defaultReasoning, selection)) return true;

    const config = get().config;
    if (!config) throw productError('settings.inferenceFailure.configUnavailable');
    await commitChanges(get, set, 'inference', config.revision, [{
      op: 'set',
      pathTemplate: '/providers/{providerId}/models/{modelId}/defaultReasoning',
      bindings: { providerId: target.providerId, modelId: target.modelId },
      value: selection,
    }]);
    return true;
  }),

  updateSelection: (kind, target) => serializeMutation(set, async () => {
    await persistSelection(get, set, kind, target);
    return true;
  }),

  upsertCatalogModel: (model) => serializeMutation(set, async () => {
    const current = get().localCatalog;
    if (!current) throw productError('settings.inferenceFailure.catalogUnavailable');
    const { id, ...value } = model;
    await commitChanges(get, set, 'model-catalog', current.revision, [{
      op: 'set',
      pathTemplate: '/models/{modelId}',
      bindings: { modelId: id },
      value,
    }]);
    return true;
  }),

  removeCatalogModel: (modelId) => serializeMutation(set, async () => {
    const current = get().localCatalog;
    if (!current) throw productError('settings.inferenceFailure.catalogUnavailable');
    await commitChanges(get, set, 'model-catalog', current.revision, [{
      op: 'remove',
      pathTemplate: '/models/{modelId}',
      bindings: { modelId },
    }]);
    return true;
  }),

  probe: async (level, target) => {
    set({ error: null });
    try {
      return await window.piskie.inference.probe({ level, target });
    } catch (error) {
      set({ error: mutationError(error) });
      return null;
    }
  },

  readArtifact: async (artifactId) => {
    set({ error: null });
    try {
      return await window.piskie.inference.artifact(artifactId);
    } catch (error) {
      set({ error: mutationError(error) });
      return null;
    }
  },

  clearError: () => set({ error: null }),
}));

export function createProviderId(): string {
  return `provider_${createUuid()}`;
}

export function customCatalogId(providerId: string, modelId: string): string {
  return `custom/${providerId}/${modelId}`;
}

export function formatModelReference(target: ModelTarget): string {
  return `${target.providerId}::${target.modelId}`;
}

export function parseModelReference(reference: string): ModelTarget | undefined {
  const separator = reference.indexOf('::');
  if (separator <= 0 || separator === reference.length - 2) return undefined;
  return {
    providerId: reference.slice(0, separator),
    modelId: reference.slice(separator + 2),
  };
}

function sameReasoningSelection(
  left: ReasoningSelection | undefined,
  right: ReasoningSelection,
): boolean {
  if (!left || left.kind !== right.kind) return false;
  if (left.kind === 'effort' && right.kind === 'effort') return left.effort === right.effort;
  if (left.kind === 'budget' && right.kind === 'budget') return left.tokens === right.tokens;
  return true;
}

export function getAvailableModelOptions(
  config: InferenceConfig | null,
  definitions: readonly InferenceModelDefinition[],
  availableTargets: readonly ModelTarget[],
  kind: InferenceGatewayKind = 'ai',
): ModelOptGroup[] {
  if (!config) return [];
  const catalog = new Map(definitions.map((model) => [model.id, model]));
  const available = new Set(availableTargets.map(formatModelReference));
  return Object.entries(config.providers)
    .filter(([, provider]) => provider.enabled)
    .map(([providerId, provider]): ModelOptGroup | undefined => {
      const options = Object.entries(provider.models).flatMap(([modelId, binding]) => {
        const definition = catalog.get(binding.catalogId);
        const target = { providerId, modelId };
        if (!binding.enabled || !definition || definition.kind !== kind
          || !available.has(formatModelReference(target))) return [];
        return [{
          label: definition.displayName || modelId,
          value: formatModelReference(target),
          target,
          definition,
          ...(binding.defaultReasoning && { defaultReasoning: binding.defaultReasoning }),
        }];
      }).sort((left, right) => compareModelDefinitions(left.definition, right.definition)
        || left.target.modelId.localeCompare(right.target.modelId));
      return options.length > 0 ? { label: provider.displayName, options } : undefined;
    })
    .filter((group): group is ModelOptGroup => group !== undefined);
}

function compareModelDefinitions(
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
