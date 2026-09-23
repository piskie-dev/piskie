import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { InferenceCatalogModelInput, InferenceConfig, InferenceModelBinding, InferenceModelDefinition } from '@shared/types/inference';
import '@/i18n';
import { useWorkerPreferencesStore } from '@/features/agents/worker-preferences-store';
import { useInferenceStore } from '@/store/inferenceStore';
import { useProxyStore } from '@/store/proxyStore';
import { useWebSearchStore } from '@/store/webSearchStore';
import { PrefDeckPage } from '../PrefDeckPage';

const dom = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const browser = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'HTMLDialogElement', 'localStorage'] as const) {
    vi.stubGlobal(name, name === 'window' ? browser.window : browser.window[name]);
  }
  return browser;
});
const originalInference = useInferenceStore.getState();
const originalProxy = useProxyStore.getState();
const originalSearch = useWebSearchStore.getState();
const originalWorkers = useWorkerPreferencesStore.getState();
const definition = (name: string): InferenceModelDefinition => ({
  id: `openai/${name}`, displayName: `Model ${name}`, family: 'openai', kind: 'ai',
  lifecycle: 'active', compatibleDrivers: ['openai'], inputModalities: ['text'], outputModalities: ['text'],
  capabilities: {}, limits: { contextWindow: 128_000 }, source: { kind: 'bundled', version: 'fixture' },
});
const catalog = ['one', 'two', 'three', 'four', 'five'].map(definition);
const binding = (name: string): InferenceModelBinding => ({
  catalogId: `openai/${name}`, upstreamId: name, enabled: true, options: {},
});
const baseConfig: InferenceConfig = {
  schemaVersion: 1, revision: 1,
  providers: { sample: {
    displayName: 'Example provider', driver: 'openai', enabled: true,
    connection: { baseUrl: 'https://api.openai.com/v1', auth: { kind: 'none' }, headers: {}, proxyId: null },
    models: { one: binding('one') }, driverOptions: {},
  } },
  policies: {
    ai: { maxAttempts: 1, connectTimeoutMs: 1000, streamIdleTimeoutMs: 1000, retryBaseDelayMs: 100 },
    image: { maxSubmitAttempts: 1, submitTimeoutMs: 1000, operationTimeoutMs: 1000, allowResubmitAfterAccepted: false },
  },
};

let container: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
let failCatalog = false;
let failBinding = false;
const upsertCatalogModel = vi.fn(async (model: InferenceCatalogModelInput) => {
  if (failCatalog) return false;
  useInferenceStore.setState((state) => ({ models: {
    ...state.models,
    ai: [...state.models.ai.filter((entry) => entry.id !== model.id), {
      ...model, source: { kind: 'local' as const, version: 'fixture' },
    }],
  } }));
  return true;
});
const upsertProviderModel = vi.fn(async (_gateway: 'ai' | 'image', providerId: string, modelId: string,
  modelBinding: InferenceModelBinding, previousModelId?: string) => {
  if (failBinding) return false;
  useInferenceStore.setState((state) => {
    const current = state.config!;
    const provider = current.providers[providerId]!;
    const models = { ...provider.models };
    if (previousModelId && previousModelId !== modelId) delete models[previousModelId];
    models[modelId] = modelBinding;
    return {
      config: { ...current, revision: current.revision + 1, providers: {
        ...current.providers, [providerId]: { ...provider, models },
      } },
      availableTargets: { ...state.availableTargets, ai: Object.entries(models)
        .filter(([, entry]) => entry.enabled)
        .map(([id, entry]) => ({ providerId, modelId: id, catalogId: entry.catalogId })) },
    };
  });
  return true;
});

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
});

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  localStorage.clear();
  failCatalog = false;
  failBinding = false;
  vi.clearAllMocks();
  useInferenceStore.setState({
    config: structuredClone(baseConfig),
    models: { ai: [catalog[0]!], image: [] }, catalogModels: { ai: catalog, image: [] },
    availableTargets: { ai: [{ providerId: 'sample', modelId: 'one', catalogId: 'openai/one' }], image: [] },
    selections: { schemaVersion: 1, revision: 1, ai: { providerId: 'sample', modelId: 'one' } },
    drivers: [{ id: 'openai', supportedGateways: ['ai'], acceptedAuth: ['none'] }],
    error: null, isLoading: false, isApplying: false,
    refresh: async () => {}, subscribeToConfigChanges: () => () => {},
    upsertCatalogModel, upsertProviderModel,
  });
  useProxyStore.setState({ config: { proxies: [] } });
  useWebSearchStore.setState({
    config: { revision: 1, enabled: false, defaultProvider: null, providers: {} },
    presets: [], error: null, refresh: async () => {}, subscribeToConfigChanges: () => () => {},
  });
  useWorkerPreferencesStore.setState({
    document: { schemaVersion: 1, revision: 1, profiles: {} },
    types: [{ type: 'explore', description: '' }], drafts: {}, loading: false, saving: null,
    loadError: null, refresh: async () => {},
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  router = createMemoryRouter([
    { path: '/preferences', element: createElement(PrefDeckPage) },
    { path: '/agents', element: createElement('p', null, 'Explore settings') },
  ], { initialEntries: ['/preferences?sect=ai'] });
  await act(async () => root.render(createElement(RouterProvider, { router })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  router.dispose();
  useInferenceStore.setState(originalInference, true);
  useProxyStore.setState(originalProxy, true);
  useWebSearchStore.setState(originalSearch, true);
  useWorkerPreferencesStore.setState(originalWorkers, true);
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

const hint = () => container.querySelector<HTMLElement>('[class*="exploreHint"]');
const click = (element: HTMLElement) => act(async () => element.click());
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
  .find((node) => node.textContent?.trim() === label)!;

async function addModel(name: string) {
  await click(button('Add Model'));
  const dialog = container.querySelector<HTMLDialogElement>('dialog[open]')!;
  await act(async () => dialog.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')!.focus());
  const choice = [...dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((node) => node.textContent?.includes(`Model ${name}`))!;
  await click(choice);
  await click([...dialog.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === 'Add Model')!);
}

it('prompts only after the second successfully configured AI model, and again after later saves', async () => {
  expect(hint()).toBeNull();
  failCatalog = true;
  await addModel('two');
  expect(hint()).toBeNull();
  expect(upsertProviderModel).not.toHaveBeenCalled();
  await click(button('Cancel'));

  failCatalog = false;
  failBinding = true;
  await addModel('two');
  expect(hint()).toBeNull();
  await click(button('Cancel'));

  failBinding = false;
  await addModel('two');
  expect(hint()?.textContent).toContain('Configure Explore');
  expect(hint()!.querySelectorAll('button')).toHaveLength(2);
  expect(localStorage.getItem('piskie-explore-model-hint-disabled')).toBeNull();
  await click(button('Configure Explore'));
  expect(router.state.location.pathname).toBe('/agents');
  expect(localStorage.getItem('piskie-explore-model-hint-disabled')).toBeNull();
  await act(async () => router.navigate('/preferences?sect=ai'));
  expect(hint()).toBeNull();

  failBinding = true;
  await addModel('three');
  expect(hint()).toBeNull();
  await click(button('Cancel'));
  failBinding = false;
  await addModel('three');
  expect(hint()).not.toBeNull();
  await click(button('Configure Explore'));
  await act(async () => router.navigate('/preferences?sect=ai'));
  await addModel('four');
  expect(hint()).not.toBeNull();
  await click(button("Don't remind me again"));
  expect(localStorage.getItem('piskie-explore-model-hint-disabled')).toBe('1');
  await addModel('five');
  expect(hint()).toBeNull();
});

it('does not prompt on a page visit with two models, on an existing model edit, or when Explore is fixed', async () => {
  await addModel('two');
  await act(async () => router.navigate('/agents?type=explore'));
  await act(async () => router.navigate('/preferences?sect=ai'));
  expect(hint()).toBeNull();
  await click(button('Edit'));
  await click(button('Save'));
  expect(hint()).toBeNull();

  useWorkerPreferencesStore.setState({ document: {
    schemaVersion: 1, revision: 2, profiles: {
      explore: { inference: { target: { providerId: 'sample', modelId: 'one' }, reasoning: { kind: 'provider-default' } } },
    },
  } });
  await addModel('three');
  expect(hint()).toBeNull();
});

it('does not prompt when a new model is saved disabled even if other models are available', async () => {
  await addModel('two');
  await click(button('Configure Explore'));
  await act(async () => router.navigate('/preferences?sect=ai'));
  await click(button('Add Model'));
  const dialog = container.querySelector<HTMLDialogElement>('dialog[open]')!;
  await act(async () => dialog.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')!.focus());
  await click([...dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((node) => node.textContent?.includes('Model three'))!);
  await click(dialog.querySelector<HTMLButtonElement>('button[aria-label="Enable Model"]')!);
  await click([...dialog.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === 'Add Model')!);
  expect(hint()).toBeNull();
});
