import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { InferenceConfig, InferenceModelDefinition } from '@shared/types/inference';
import { useInferenceStore } from '@/store/inferenceStore';
import { useProxyStore } from '@/store/proxyStore';
import { useWebSearchStore } from '@/store/webSearchStore';
import { PrefDeckPage } from '../PrefDeckPage';
import '@/i18n';

const initialInference = useInferenceStore.getState();
const initialProxy = useProxyStore.getState();
const initialSearch = useWebSearchStore.getState();
let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

const ids = ['first', 'second', 'third'];
const definitions = (kind: 'ai' | 'image'): InferenceModelDefinition[] => ids.map((id) => ({
  id: `${kind}-${id}`, displayName: `Model ${kind}-${id}`, kind, lifecycle: 'active',
  compatibleDrivers: ['openai'], inputModalities: ['text'], outputModalities: [kind === 'ai' ? 'text' : 'image'],
  capabilities: {}, limits: {}, source: { kind: 'local', version: 'test' },
}));
const config: InferenceConfig = {
  schemaVersion: 1, revision: 1,
  providers: Object.fromEntries(ids.map((id) => [id, {
    displayName: `Provider ${id}`, driver: 'openai', enabled: true,
    connection: { baseUrl: 'https://api.example.test', auth: { kind: 'none' as const }, headers: {}, proxyId: null },
    models: Object.fromEntries(['ai', 'image'].map((kind) => [`${kind}-${id}`, {
      catalogId: `${kind}-${id}`, upstreamId: `${kind}-${id}`, enabled: true, options: {},
    }])),
    driverOptions: {},
  }])),
  policies: {
    ai: { maxAttempts: 1, connectTimeoutMs: 1000, streamIdleTimeoutMs: 1000, retryBaseDelayMs: 100 },
    image: { maxSubmitAttempts: 1, submitTimeoutMs: 1000, operationTimeoutMs: 1000, allowResubmitAfterAccepted: false },
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
  useInferenceStore.setState({
    config: null, selections: null, drivers: [], models: { ai: [], image: [] },
    error: null, isLoading: false, refresh: async () => {},
    subscribeToConfigChanges: () => () => {},
  });
  useProxyStore.setState({ config: { proxies: [] } });
  useWebSearchStore.setState({
    config: { revision: 1, enabled: false, defaultProvider: null, providers: {} },
    presets: [], error: null, refresh: async () => {}, subscribeToConfigChanges: () => () => {},
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useInferenceStore.setState(initialInference, true);
  useProxyStore.setState(initialProxy, true);
  useWebSearchStore.setState(initialSearch, true);
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

const twig = (gateway: 'ai' | 'image', id: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(`[data-sub="${gateway}"] button`)]
    .find((button) => button.textContent?.includes(`Provider ${id}`))!;
const visibleProvider = () => container.querySelector('main')?.textContent ?? '';

it('follows each gateway default after async config reads, while retaining explicit provider choices', async () => {
  await act(async () => root.render(createElement(MemoryRouter, { initialEntries: ['/preferences?sect=ai'] },
    createElement(PrefDeckPage))));
  expect(twig('ai', 'first')).toBeUndefined();

  await act(async () => useInferenceStore.setState({
    config, drivers: [{ id: 'openai', supportedGateways: ['ai', 'image'], acceptedAuth: ['none'] }],
    models: { ai: definitions('ai'), image: definitions('image') },
  }));
  expect(twig('ai', 'first').dataset.on).toBe('true');

  await act(async () => useInferenceStore.setState({ selections: {
    schemaVersion: 1, revision: 1,
    ai: { providerId: 'second', modelId: 'ai-second' },
    image: { providerId: 'third', modelId: 'image-third' },
  } }));
  expect(twig('ai', 'second').dataset.on).toBe('true');
  expect(visibleProvider()).toContain('Provider second');

  const imageCategory = [...container.querySelectorAll<HTMLButtonElement>('aside button')]
    .find((button) => button.textContent?.includes('Image Providers'))!;
  await act(async () => imageCategory.click());
  expect(twig('image', 'third').dataset.on).toBe('true');
  expect(visibleProvider()).toContain('Provider third');
  await act(async () => twig('image', 'first').click());
  expect(twig('image', 'first').dataset.on).toBe('true');
  await act(async () => twig('ai', 'first').click());
  expect(twig('ai', 'first').dataset.on).toBe('true');

  await act(async () => useInferenceStore.setState({ selections: {
    schemaVersion: 1, revision: 2,
    ai: { providerId: 'second', modelId: 'ai-second' },
    image: { providerId: 'third', modelId: 'image-third' },
  } }));
  expect(twig('ai', 'first').dataset.on).toBe('true');
  await act(async () => twig('image', 'first').click());
  expect(twig('image', 'first').dataset.on).toBe('true');

  await act(async () => useInferenceStore.setState({ config: {
    ...config, revision: 2, providers: { second: config.providers.second!, third: config.providers.third! },
  } }));
  expect(twig('image', 'third').dataset.on).toBe('true');
  const aiCategory = [...container.querySelectorAll<HTMLButtonElement>('aside button')]
    .find((button) => button.textContent?.includes('AI Providers'))!;
  await act(async () => aiCategory.click());
  expect(twig('ai', 'second').dataset.on).toBe('true');
});
