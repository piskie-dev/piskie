import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceConfig, InferenceModelDefinition } from '@shared/types/inference';
import '@/i18n';
import { useInferenceStore } from '@/store/inferenceStore';
import { useProxyStore } from '@/store/proxyStore';
import { useWorkerPreferencesStore } from '@/features/agents/worker-preferences-store';
import { ProviderDesk } from '../desks/ProviderDesk';

const initialInference = useInferenceStore.getState();
const initialProxy = useProxyStore.getState();
const initialWorkers = useWorkerPreferencesStore.getState();
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

const config: InferenceConfig = {
  schemaVersion: 1,
  revision: 1,
  providers: {
    sample: {
      displayName: 'Sample provider',
      driver: 'openai',
      enabled: true,
      connection: {
        baseUrl: 'https://api.example.test',
        auth: { kind: 'bearer', value: 'sample-key' },
        headers: {},
        proxyId: null,
      },
      models: {
        'sample-model': {
          catalogId: 'sample-catalog',
          upstreamId: 'sample-upstream',
          enabled: true,
          options: {},
        },
      },
      driverOptions: {},
    },
  },
  policies: {
    ai: {
      maxAttempts: 1,
      connectTimeoutMs: 1_000,
      streamIdleTimeoutMs: 1_000,
      retryBaseDelayMs: 100,
    },
    image: {
      maxSubmitAttempts: 1,
      submitTimeoutMs: 1_000,
      operationTimeoutMs: 1_000,
      allowResubmitAfterAccepted: false,
    },
  },
};

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'localStorage'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  dom.window.localStorage.clear();
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useInferenceStore.setState(initialInference, true);
  useProxyStore.setState(initialProxy, true);
  useWorkerPreferencesStore.setState(initialWorkers, true);
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

async function renderProvider(contextWindow: number): Promise<string> {
  const model: InferenceModelDefinition = {
    id: 'sample-catalog',
    displayName: 'Sample model',
    kind: 'ai',
    lifecycle: 'active',
    compatibleDrivers: ['openai'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    capabilities: {},
    limits: { contextWindow },
    source: { kind: 'local', version: 'sample' },
  };

  useInferenceStore.setState({
    config,
    selections: null,
    models: { ai: [model], image: [] },
    isApplying: false,
  });
  useProxyStore.setState({ config: { proxies: [] } });

  await act(async () => root.render(createElement(ProviderDesk, {
      gateway: 'ai',
      providerId: 'sample',
      onEditModel: vi.fn(),
      onVanish: vi.fn(),
      onFlash: vi.fn(),
      onShowImage: vi.fn(),
      onOpenExplore: vi.fn(),
    })));

  return container.textContent ?? '';
}

describe('ProviderDesk context window', () => {
  it.each([
    [1_050_000, '1.05M'],
    [1_000_000, '1M'],
    [128_000, '128K'],
  ])('formats %i tokens as %s', async (contextWindow, expected) => {
    expect(await renderProvider(contextWindow)).toContain(expected);
  });
});

function prepareExploreHint() {
  const ids = ['primary-model', 'alternate-model'];
  const nextConfig = structuredClone(config);
  nextConfig.providers.sample!.models = Object.fromEntries(ids.map((id) => [id, {
    catalogId: `custom/sample/${id}`, upstreamId: id, enabled: true, options: {},
  }]));
  const definitions: InferenceModelDefinition[] = ids.map((id, index) => ({
    id: `custom/sample/${id}`, displayName: id, kind: 'ai', family: index ? 'other' : 'unknown',
    lifecycle: 'active', compatibleDrivers: ['openai'], inputModalities: ['text'],
    outputModalities: ['text'], capabilities: {}, limits: {},
    source: { kind: 'local', version: 'test' },
  }));
  useInferenceStore.setState({
    config: nextConfig,
    selections: { schemaVersion: 1, revision: 1, ai: { providerId: 'sample', modelId: ids[0]! } },
    models: { ai: definitions, image: [] },
    availableTargets: { ai: [{ providerId: 'sample', modelId: ids[0]!, catalogId: definitions[0]!.id }], image: [] },
    error: null,
  });
  useWorkerPreferencesStore.setState({
    document: { schemaVersion: 1, revision: 1, profiles: {} },
    types: [{ type: 'explore', description: '' }],
    drafts: {}, loading: false, loadError: null, saving: null,
    refresh: async () => {},
  });
  useProxyStore.setState({ config: { proxies: [] } });
  return { ids, definitions };
}

const hint = () => container.querySelector<HTMLElement>('[class*="exploreHint"]');
const makeBothAvailable = (ids: string[], definitions: InferenceModelDefinition[]) =>
  useInferenceStore.setState({
    availableTargets: { ai: ids.map((modelId, index) => ({ providerId: 'sample', modelId, catalogId: definitions[index]!.id })), image: [] },
  });

function setAlternateEnabled(enabled: boolean) {
  const current = useInferenceStore.getState().config!;
  const provider = current.providers.sample!;
  useInferenceStore.setState({ config: {
    ...current,
    providers: { ...current.providers, sample: {
      ...provider,
      models: { ...provider.models, 'alternate-model': { ...provider.models['alternate-model']!, enabled } },
    } },
  } });
}

const props = {
  gateway: 'ai' as const, providerId: 'sample', onEditModel: vi.fn(), onVanish: vi.fn(),
  onFlash: vi.fn(), onShowImage: vi.fn(), onOpenExplore: vi.fn(),
  onDismissExploreHint: vi.fn(),
};
const renderHint = (exploreHintId: number | null, gateway: 'ai' | 'image' = 'ai') =>
  act(async () => root.render(createElement(ProviderDesk, { ...props, gateway, exploreHintId })));

it('does not show the prompt on a page visit with two existing models or with only one available model', async () => {
  const { ids, definitions } = prepareExploreHint();
  makeBothAvailable(ids, definitions);
  await renderHint(null);
  expect(hint()).toBeNull();
  await act(async () => makeBothAvailable(ids.slice(0, 1), definitions));
  await renderHint(1);
  expect(hint()).toBeNull();
});

it('shows the prompt for a successful second-model signal without saving Explore, including future signals after navigation', async () => {
  const { ids, definitions } = prepareExploreHint();
  await renderHint(null);
  expect(hint()).toBeNull();
  await act(async () => makeBothAvailable(ids, definitions));
  expect(hint()).toBeNull();
  await renderHint(1);
  expect(hint()?.textContent).toContain('Choose a suitable model for Explore yourself');
  expect(hint()?.textContent).not.toContain('alternate-model');
  expect(hint()?.textContent).not.toContain('tier');
  await act(async () => hint()!.querySelector('button')!.click());
  expect(props.onOpenExplore).toHaveBeenCalledOnce();
  expect(localStorage.length).toBe(0);
  expect(useWorkerPreferencesStore.getState().drafts).toEqual({});
  expect(useWorkerPreferencesStore.getState().document?.profiles.explore).toBeUndefined();
  await renderHint(null);
  await renderHint(2);
  expect(hint()).not.toBeNull();
});

it('only the visible opt-out persists across remounts and later save signals', async () => {
  const { ids, definitions } = prepareExploreHint();
  makeBothAvailable(ids, definitions);
  await renderHint(1);
  expect(hint()?.textContent).toContain("Don't remind me again");
  expect(hint()!.querySelectorAll('button')).toHaveLength(2);
  await act(async () => hint()!.querySelectorAll('button')[1]!.click());
  expect(hint()).toBeNull();
  expect(localStorage.getItem('piskie-explore-model-hint-disabled')).toBe('1');
  await act(async () => root.render(null));
  await renderHint(2);
  expect(hint()).toBeNull();
});

it('does not prompt for disabled/unavailable models, image settings, or a fixed Explore preference', async () => {
  const { ids, definitions } = prepareExploreHint();
  await renderHint(1);
  await act(async () => {
    makeBothAvailable(ids, definitions);
    useInferenceStore.setState({ isApplying: true });
  });
  expect(hint()).toBeNull();
  await act(async () => useInferenceStore.setState({ isApplying: false }));
  expect(hint()).not.toBeNull();
  await act(async () => setAlternateEnabled(false));
  expect(hint()).toBeNull();
  await act(async () => setAlternateEnabled(true));
  expect(hint()).not.toBeNull();
  await renderHint(1, 'image');
  expect(hint()).toBeNull();
  await renderHint(1);
  expect(hint()).not.toBeNull();
  await act(async () => useWorkerPreferencesStore.setState({ drafts: {
    explore: { value: { mode: 'fixed', target: { providerId: 'sample', modelId: ids[1]! } }, displayName: '', conflict: false },
  } }));
  expect(hint()).toBeNull();
  await act(async () => useWorkerPreferencesStore.setState({ drafts: {}, document: {
    schemaVersion: 1, revision: 2, profiles: {
      explore: { inference: { target: { providerId: 'sample', modelId: ids[1]! }, reasoning: { kind: 'provider-default' } } },
    },
  } }));
  expect(hint()).toBeNull();
  expect(props.onDismissExploreHint).toHaveBeenCalled();
  await renderHint(null);
  await act(async () => useWorkerPreferencesStore.setState({ document: {
    schemaVersion: 1, revision: 3, profiles: {},
  } }));
  expect(hint()).toBeNull();
});
