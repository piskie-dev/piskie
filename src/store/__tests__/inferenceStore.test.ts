import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InferenceCatalogModelInput,
  InferenceConfig,
  InferenceModelDefinition,
  InferenceProviderInstance,
  InferenceSelections,
} from '../../../shared/types/inference';
import type {
  ConfigDescriptor,
  ConfigDomainRevisionChangedEvent,
  ConfigFieldDescriptor,
  ConfigPlanRequest,
} from '../../../shared/types/config';
import {
  createProviderId,
  customCatalogId,
  getAvailableModelOptions,
  useInferenceStore,
} from '../inferenceStore';

const definition: InferenceModelDefinition = {
  id: 'custom/provider-main/model-main',
  displayName: 'Model Main',
  kind: 'ai',
  lifecycle: 'active',
  compatibleDrivers: ['openai'],
  inputModalities: ['text'],
  outputModalities: ['text'],
  capabilities: { streaming: true, tools: true },
  limits: { contextWindow: 128_000 },
  source: { kind: 'local', version: 'local:1' },
};

const imageDefinition: InferenceModelDefinition = {
  ...definition,
  id: 'custom/image-provider/image-main',
  displayName: 'Image Main',
  kind: 'image',
  outputModalities: ['image'],
  capabilities: { generate: true },
  limits: { sizes: ['1024x1024'] },
};

const provider: InferenceProviderInstance = {
  displayName: 'Provider Main',
  driver: 'openai',
  enabled: true,
  connection: {
    baseUrl: 'https://example.com/v1',
    auth: { kind: 'bearer', value: 'test-credential' },
    headers: {},
    proxyId: null,
  },
  models: {
    'model-main': {
      catalogId: definition.id,
      upstreamId: 'model-main',
      enabled: true,
      options: {},
    },
  },
  driverOptions: {},
};

const imageProvider: InferenceProviderInstance = {
  ...provider,
  displayName: 'Image Provider',
  models: {
    'image-main': {
      catalogId: imageDefinition.id,
      upstreamId: 'image-main',
      enabled: true,
      options: {},
    },
  },
};

const descriptors = {
  inference: descriptor('inference', [
    field('provider', '/providers/{providerId}', ['providerId']),
    field('provider-display-name', '/providers/{providerId}/displayName', ['providerId']),
    field('provider-enabled', '/providers/{providerId}/enabled', ['providerId']),
    field('provider-model', '/providers/{providerId}/models/{modelId}', ['providerId', 'modelId']),
    field(
      'provider-model-reasoning',
      '/providers/{providerId}/models/{modelId}/defaultReasoning',
      ['providerId', 'modelId'],
    ),
    field('image-operation-timeout', '/policies/image/operationTimeoutMs'),
  ]),
  'inference-selections': descriptor('inference-selections', [
    field('selection-ai', '/ai'),
    field('selection-image', '/image'),
  ]),
  'model-catalog': descriptor('model-catalog', [
    field('catalog-model', '/models/{modelId}', ['modelId']),
  ]),
} as const;

const inferenceDescriptor = descriptors.inference;

function field(
  name: string,
  pathTemplate: string,
  bindings: string[] = [],
): ConfigFieldDescriptor {
  return {
    fieldId: `field-${name}`,
    pathTemplate,
    bindings: bindings.map((binding) => ({ name: binding, kind: 'record-key' })),
    source: 'domain',
    leaf: true,
    required: true,
    mutability: 'write',
  };
}

function descriptor(domain: string, fields: ConfigFieldDescriptor[]): ConfigDescriptor {
  return {
    domain,
    title: domain,
    description: `${domain} configuration.`,
    schemaVersion: 1,
    descriptorHash: `descriptor-${domain}`,
    capabilities: ['show', 'plan', 'validate', 'apply', 'verify'],
    readSchema: {},
    writeSchema: {},
    fields,
    dynamicExtensions: [],
  };
}

function config(
  providers: InferenceConfig['providers'] = { 'provider-main': provider },
  revision = 3,
): InferenceConfig {
  return {
    schemaVersion: 1,
    revision,
    providers,
    policies: {
      ai: {
        maxAttempts: 3,
        connectTimeoutMs: 30_000,
        streamIdleTimeoutMs: 300_000,
        retryBaseDelayMs: 250,
      },
      image: {
        maxSubmitAttempts: 2,
        submitTimeoutMs: 60_000,
        operationTimeoutMs: 600_000,
        allowResubmitAfterAccepted: false,
      },
    },
  };
}

function selections(
  ai: InferenceSelections['ai'] | null = { providerId: 'provider-main', modelId: 'model-main' },
  revision = 1,
): InferenceSelections {
  return { schemaVersion: 1, revision, ...(ai && { ai }) };
}

function api(currentConfig: InferenceConfig, currentSelections: InferenceSelections) {
  let configChangeListener: ((event: ConfigDomainRevisionChangedEvent) => void) | undefined;
  const unsubscribeConfig = vi.fn();
  let currentCatalog = {
    version: 'local:1',
    revision: 1,
    models: {
      [definition.id]: withoutId(definition),
      [imageDefinition.id]: withoutId(imageDefinition),
    },
  };
  let planSequence = 0;
  const plans = new Map<string, { domain: keyof typeof descriptors; request: ConfigPlanRequest }>();
  const inference = {
    listDrivers: vi.fn(async () => (
      [{ id: 'openai', supportedGateways: ['ai', 'image'], acceptedAuth: ['bearer', 'none'] }]
    )),
    queryModels: vi.fn(async ({ gateway }: { gateway: 'ai' | 'image' }) => {
      const gatewayModels = gateway === 'ai' ? [definition] : [imageDefinition];
      const catalogIds = new Set(gatewayModels.map((model) => model.id));
      return {
        catalogVersion: 'test',
        gateway,
        models: gatewayModels,
        availableTargets: Object.entries(currentConfig.providers).flatMap(([providerId, configured]) => (
          configured.enabled
            ? Object.entries(configured.models).flatMap(([modelId, binding]) => (
                binding.enabled && catalogIds.has(binding.catalogId)
                  ? [{ providerId, modelId, catalogId: binding.catalogId }]
                  : []
              ))
            : []
        )),
        issues: [],
      };
    }),
    probe: vi.fn(),
    artifact: vi.fn(async (artifactId: string) => (
      { artifactId, mimeType: 'image/png', dataUrl: 'data:image/png;base64,cGl4ZWxz' }
    )),
  };
  const configClient = {
    read: vi.fn(async (domain: keyof typeof descriptors) => (
      domain === 'inference'
        ? currentConfig
        : domain === 'inference-selections'
          ? currentSelections
          : currentCatalog
    )),
    describe: vi.fn(async (domain: keyof typeof descriptors) => descriptors[domain]),
    plan: vi.fn(async (domain: keyof typeof descriptors, request: ConfigPlanRequest) => {
      const id = `plan-${++planSequence}`;
      plans.set(id, { domain, request });
      return { id, domain, baseRevision: revisionOf(domain) };
    }),
    validate: vi.fn(async (planId: string) => {
      const planned = plans.get(planId)!;
      return {
        id: planId,
        domain: planned.domain,
        baseRevision: revisionOf(planned.domain),
        validation: { valid: true, issues: [] },
      };
    }),
    apply: vi.fn(async (planId: string, expectedRevision: number) => {
      const planned = plans.get(planId)!;
      if (revisionOf(planned.domain) !== expectedRevision) {
        throw new Error('CONFIG_REVISION_CONFLICT');
      }
      if (planned.domain === 'inference') {
        currentConfig = applyRequest(currentConfig, descriptors.inference, planned.request);
      } else if (planned.domain === 'inference-selections') {
        currentSelections = applyRequest(
          currentSelections,
          descriptors['inference-selections'],
          planned.request,
        );
      } else {
        currentCatalog = applyRequest(currentCatalog, descriptors['model-catalog'], planned.request);
        currentCatalog.version = `local:${currentCatalog.revision}`;
      }
      return {
        domain: planned.domain,
        previousRevision: expectedRevision,
        revision: expectedRevision + 1,
      };
    }),
    verify: vi.fn(async (domain: keyof typeof descriptors, expectedRevision: number) => (
      { domain, expectedRevision, healthy: true, issues: [] }
    )),
    observeChanges: vi.fn((listener: (event: ConfigDomainRevisionChangedEvent) => void) => {
      configChangeListener = listener;
      return unsubscribeConfig;
    }),
  };

  function revisionOf(domain: keyof typeof descriptors): number {
    if (domain === 'inference') return currentConfig.revision;
    if (domain === 'inference-selections') return currentSelections.revision;
    return currentCatalog.revision;
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      piskie: {
        inference,
        configuration: configClient,
      },
    },
  });
  return {
    inference,
    config: configClient,
    emitConfigChanged: (event: ConfigDomainRevisionChangedEvent) => configChangeListener?.(event),
    unsubscribeConfig,
  };
}

function applyRequest<T extends { revision: number }>(
  document: T,
  descriptor: ConfigDescriptor,
  request: ConfigPlanRequest,
): T {
  const next = structuredClone(document) as Record<string, unknown> & { revision: number };
  for (const change of request.changes) {
    const field = descriptor.fields.find((candidate) => candidate.fieldId === change.fieldId)!;
    const path = field.pathTemplate.split('/').slice(1).map((token) => {
      const placeholder = /^\{(.+)\}$/.exec(token)?.[1];
      return placeholder ? String(change.bindings?.[placeholder]) : token;
    });
    const key = path.pop()!;
    const parent = path.reduce<Record<string, unknown>>((value, segment) => {
      return value[segment] as Record<string, unknown>;
    }, next);
    if (change.op === 'remove') delete parent[key];
    else parent[key] = structuredClone(change.value);
  }
  next.revision += 1;
  return next as T;
}

function withoutId<T extends { id: string }>(value: T): Omit<T, 'id'> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'id'),
  ) as Omit<T, 'id'>;
}

function resetStore(currentConfig: InferenceConfig, currentSelections: InferenceSelections) {
  useInferenceStore.setState({
    config: currentConfig,
    descriptors,
    localCatalog: { version: 'local:1', revision: 1, models: [definition] },
    selections: currentSelections,
    drivers: [{ id: 'openai', supportedGateways: ['ai', 'image'], acceptedAuth: ['bearer', 'none'] }],
    models: { ai: [definition], image: [] },
    availableTargets: {
      ai: [{ providerId: 'provider-main', modelId: 'model-main', catalogId: definition.id }],
      image: [],
    },
    isLoading: false,
    isApplying: false,
    error: null,
  });
}

describe('inferenceStore configuration mutations', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('refreshes revision 14 to 15 when another config entry point commits', async () => {
    const currentSelections = selections();
    const gateway = api(config({}, 15), currentSelections);
    resetStore(config(undefined, 14), currentSelections);
    const unsubscribe = useInferenceStore.getState().subscribeToConfigChanges();

    gateway.emitConfigChanged({
      domain: 'inference',
      revision: 15,
      descriptorHash: inferenceDescriptor.descriptorHash,
      source: 'external',
    });

    await vi.waitFor(() => expect(useInferenceStore.getState().config?.revision).toBe(15));
    expect(gateway.config.read).toHaveBeenCalledWith('inference');
    unsubscribe();
    expect(gateway.unsubscribeConfig).toHaveBeenCalledOnce();
  });

  it('uses the shared config transaction and its Plan CAS revision', async () => {
    const currentConfig = config();
    const currentSelections = selections();
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);

    await expect(useInferenceStore.getState().updateProvider('provider-main', {
      displayName: 'Renamed Provider',
    })).resolves.toBe(true);

    expect(gateway.config.plan).toHaveBeenCalledWith('inference', {
      descriptorHash: descriptors.inference.descriptorHash,
      changes: [{
        op: 'set',
        fieldId: 'field-provider-display-name',
        bindings: { providerId: 'provider-main' },
        value: 'Renamed Provider',
      }],
    });
    expect(gateway.config.validate).toHaveBeenCalledWith('plan-1');
    expect(gateway.config.apply).toHaveBeenCalledWith('plan-1', 3);
    expect(gateway.config.verify).toHaveBeenCalledWith('inference', 4);
  });

  it('selects the first enabled model when creating a Provider without an AI default', async () => {
    const currentConfig = config({});
    const currentSelections = selections(null);
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);

    await expect(useInferenceStore.getState().addProvider(
      'ai',
      'provider-main',
      provider,
      'model-main',
    )).resolves.toBe(true);

    expect(gateway.config.plan).toHaveBeenNthCalledWith(2, 'inference-selections', {
      descriptorHash: descriptors['inference-selections'].descriptorHash,
      changes: [{
        op: 'set',
        fieldId: 'field-selection-ai',
        value: { providerId: 'provider-main', modelId: 'model-main' },
      }],
    });
    expect(useInferenceStore.getState().selections?.ai).toEqual({
      providerId: 'provider-main',
      modelId: 'model-main',
    });
  });

  it('selects the first enabled model added to an existing Provider', async () => {
    const emptyProvider = { ...provider, models: {} };
    const currentConfig = config({ 'provider-main': emptyProvider });
    const currentSelections = selections(null);
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);

    await expect(useInferenceStore.getState().upsertProviderModel(
      'ai',
      'provider-main',
      'model-main',
      provider.models['model-main']!,
    )).resolves.toBe(true);

    expect(gateway.config.plan).toHaveBeenNthCalledWith(2, 'inference-selections', {
      descriptorHash: descriptors['inference-selections'].descriptorHash,
      changes: [{
        op: 'set',
        fieldId: 'field-selection-ai',
        value: { providerId: 'provider-main', modelId: 'model-main' },
      }],
    });
  });

  it('selects the first enabled image model as the image default', async () => {
    const currentConfig = config({});
    const currentSelections = selections(null);
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);

    await expect(useInferenceStore.getState().addProvider(
      'image',
      'image-provider',
      imageProvider,
      'image-main',
    )).resolves.toBe(true);

    expect(gateway.config.plan).toHaveBeenNthCalledWith(2, 'inference-selections', {
      descriptorHash: descriptors['inference-selections'].descriptorHash,
      changes: [{
        op: 'set',
        fieldId: 'field-selection-image',
        value: { providerId: 'image-provider', modelId: 'image-main' },
      }],
    });
    expect(useInferenceStore.getState().selections?.image).toEqual({
      providerId: 'image-provider',
      modelId: 'image-main',
    });
  });

  it('keeps the current default when another enabled model is added', async () => {
    const currentConfig = config();
    const currentSelections = selections();
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);

    await expect(useInferenceStore.getState().upsertProviderModel(
      'ai',
      'provider-main',
      'model-next',
      {
        ...provider.models['model-main']!,
        upstreamId: 'model-next',
      },
    )).resolves.toBe(true);

    expect(gateway.config.plan).toHaveBeenCalledTimes(1);
    expect(useInferenceStore.getState().selections?.ai).toEqual({
      providerId: 'provider-main',
      modelId: 'model-main',
    });
  });

  it('does not select a first model that is disabled', async () => {
    const emptyProvider = { ...provider, models: {} };
    const currentConfig = config({ 'provider-main': emptyProvider });
    const currentSelections = selections(null);
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);

    await expect(useInferenceStore.getState().upsertProviderModel(
      'ai',
      'provider-main',
      'model-main',
      { ...provider.models['model-main']!, enabled: false },
    )).resolves.toBe(true);

    expect(gateway.config.plan).toHaveBeenCalledTimes(1);
    expect(useInferenceStore.getState().selections?.ai).toBeUndefined();
  });

  it('clears only the exact selection after deleting its provider and never selects a fallback', async () => {
    const currentConfig = config();
    const currentSelections = selections();
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);

    await expect(useInferenceStore.getState().removeProvider('provider-main')).resolves.toBe(true);

    expect(gateway.config.plan).toHaveBeenNthCalledWith(1, 'inference-selections', {
      descriptorHash: descriptors['inference-selections'].descriptorHash,
      changes: [{ op: 'remove', fieldId: 'field-selection-ai' }],
    });
    expect(gateway.config.plan).toHaveBeenNthCalledWith(2, 'inference', {
      descriptorHash: descriptors.inference.descriptorHash,
      changes: [{
        op: 'remove',
        fieldId: 'field-provider',
        bindings: { providerId: 'provider-main' },
      }],
    });
    expect(useInferenceStore.getState().selections?.ai).toBeUndefined();
    expect(useInferenceStore.getState().config?.providers['provider-main']).toBeUndefined();
  });

  it('clears the current model when it is disabled without changing any other target', async () => {
    const currentConfig = config();
    const currentSelections: InferenceSelections = {
      ...selections(),
      image: { providerId: 'image-provider', modelId: 'image-model' },
    };
    const disabledProvider: InferenceProviderInstance = {
      ...provider,
      models: {
        'model-main': { ...provider.models['model-main']!, enabled: false },
      },
    };
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);

    await expect(useInferenceStore.getState().upsertProviderModel(
      'ai',
      'provider-main',
      'model-main',
      disabledProvider.models['model-main']!,
      'model-main',
    )).resolves.toBe(true);

    expect(gateway.config.plan).toHaveBeenNthCalledWith(2, 'inference-selections', {
      descriptorHash: descriptors['inference-selections'].descriptorHash,
      changes: [{ op: 'remove', fieldId: 'field-selection-ai' }],
    });
    expect(useInferenceStore.getState().selections?.image).toEqual({
      providerId: 'image-provider',
      modelId: 'image-model',
    });
  });

  it('persists the model selected by the user as one exact target', async () => {
    const currentConfig = config();
    const currentSelections = selections(null);
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);

    const target = { providerId: 'provider-main', modelId: 'model-main' };
    await expect(useInferenceStore.getState().updateSelection('ai', target)).resolves.toBe(true);

    expect(gateway.config.plan).toHaveBeenCalledWith('inference-selections', {
      descriptorHash: descriptors['inference-selections'].descriptorHash,
      changes: [{ op: 'set', fieldId: 'field-selection-ai', value: target }],
    });
    expect(gateway.config.plan).toHaveBeenCalledTimes(1);
  });

  it('updates the local catalog through the model-catalog Domain', async () => {
    const currentConfig = config();
    const currentSelections = selections();
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);
    const catalogModel = Object.fromEntries(Object.entries({
      ...definition,
      id: 'custom/provider-main/model-next',
      displayName: 'Model Next',
    }).filter(([key]) => key !== 'source')) as InferenceCatalogModelInput;

    await expect(useInferenceStore.getState().upsertCatalogModel(catalogModel)).resolves.toBe(true);

    expect(gateway.config.plan).toHaveBeenCalledWith('model-catalog', {
      descriptorHash: descriptors['model-catalog'].descriptorHash,
      changes: [{
        op: 'set',
        fieldId: 'field-catalog-model',
        bindings: { modelId: catalogModel.id },
        value: withoutId(catalogModel),
      }],
    });
    expect(useInferenceStore.getState().localCatalog?.models)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: catalogModel.id })]));
  });

  it('updates the global image operation timeout through a validated config plan', async () => {
    const currentConfig = config();
    const currentSelections = selections();
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);

    await expect(useInferenceStore.getState().updatePolicies('image', {
      operationTimeoutMs: 600_000,
    })).resolves.toBe(true);

    expect(gateway.config.plan).toHaveBeenCalledWith('inference', {
      descriptorHash: descriptors.inference.descriptorHash,
      changes: [{
        op: 'set',
        fieldId: 'field-image-operation-timeout',
        value: 600_000,
      }],
    });
  });

  it('persists the displayed reasoning strength on the exact model binding', async () => {
    const currentConfig = config();
    const currentSelections = selections();
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);

    await expect(useInferenceStore.getState().updateModelReasoningDefault(
      'provider-main::model-main',
      { kind: 'effort', effort: 'high' },
    )).resolves.toBe(true);

    expect(gateway.config.plan).toHaveBeenCalledWith('inference', {
      descriptorHash: descriptors.inference.descriptorHash,
      changes: [{
        op: 'set',
        fieldId: 'field-provider-model-reasoning',
        bindings: { providerId: 'provider-main', modelId: 'model-main' },
        value: { kind: 'effort', effort: 'high' },
      }],
    });
  });

  it('reads an image artifact preview through the restricted inference IPC', async () => {
    const currentConfig = config();
    const currentSelections = selections();
    const gateway = api(currentConfig, currentSelections);
    resetStore(currentConfig, currentSelections);
    const artifactId = `artifact:sha256:${'a'.repeat(64)}`;

    await expect(useInferenceStore.getState().readArtifact(artifactId)).resolves.toEqual({
      artifactId,
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,cGl4ZWxz',
    });
    expect(gateway.inference.artifact).toHaveBeenCalledWith(artifactId);
  });

  it('keeps generated identifiers internal and stable-shaped', () => {
    expect(createProviderId()).toMatch(/^provider_[0-9a-f-]{36}$/);
    expect(customCatalogId('provider-main', 'vendor/model')).toBe('custom/provider-main/vendor/model');
  });

  it('orders each Provider model dropdown by local catalog release date', () => {
    const older: InferenceModelDefinition = {
      ...definition,
      id: 'vendor/model-old',
      displayName: 'Model Old',
      releaseDate: '2025-01-01',
    };
    const newer: InferenceModelDefinition = {
      ...definition,
      id: 'vendor/model-new',
      displayName: 'Model New',
      releaseDate: '2026-07-01',
    };
    const configuredProvider: InferenceProviderInstance = {
      ...provider,
      models: {
        old: { catalogId: older.id, upstreamId: 'model-old', enabled: true, options: {} },
        new: {
          catalogId: newer.id,
          upstreamId: 'model-new',
          enabled: true,
          defaultReasoning: { kind: 'effort', effort: 'high' },
          options: {},
        },
      },
    };

    const groups = getAvailableModelOptions(
      config({ 'provider-main': configuredProvider }),
      [older, newer],
      [
        { providerId: 'provider-main', modelId: 'old' },
        { providerId: 'provider-main', modelId: 'new' },
      ],
      'ai',
    );

    expect(groups[0]?.options.map((option) => option.target.modelId)).toEqual(['new', 'old']);
    expect(groups[0]?.options[0]?.defaultReasoning).toEqual({ kind: 'effort', effort: 'high' });
  });

  it('does not expose a configured model absent from the runtime availability projection', () => {
    const groups = getAvailableModelOptions(
      config(),
      [definition],
      [],
      'ai',
    );

    expect(groups).toEqual([]);
  });
});
