import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { NO_REASONING } from '@shared/ai-model-catalog';
import type { InferenceModelDefinition, InferenceProviderInstance } from '@shared/types/inference';
import { useInferenceStore } from '@/store/inferenceStore';
import { useProxyStore } from '@/store/proxyStore';
import { vendorsFor } from '../../data/vendor-atlas';
import { ModelForge } from '../ModelForge';

const dom = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const browser = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', browser.window);
  vi.stubGlobal('document', browser.window.document);
  vi.stubGlobal('navigator', browser.window.navigator);
  vi.stubGlobal('HTMLElement', browser.window.HTMLElement);
  vi.stubGlobal('HTMLDialogElement', browser.window.HTMLDialogElement);
  return browser;
});

let container: HTMLDivElement;
let root: Root;
const originalInference = useInferenceStore.getState();
const originalProxy = useProxyStore.getState();
const upsertCatalogModel = vi.fn(async () => true);
const upsertProviderModel = vi.fn(async () => true);
const refreshCatalog = vi.fn(async () => ({ updated: true }));
const system: InferenceModelDefinition = {
  id: 'openai/example-model', displayName: 'System Model', family: 'openai', kind: 'ai',
  lifecycle: 'active', compatibleDrivers: ['openai'], inputModalities: ['text'], outputModalities: ['text'],
  capabilities: { reasoning: false }, reasoning: NO_REASONING, limits: { contextWindow: 128_000 },
  source: { kind: 'bundled', version: 'example' },
};
const saved: InferenceModelDefinition = {
  ...system, displayName: 'Saved Model', limits: { contextWindow: 96_000 },
  source: { kind: 'local', version: 'local:1' },
};
const provider: InferenceProviderInstance = {
  displayName: 'Example Provider', driver: 'openai', enabled: true,
  connection: { baseUrl: 'https://example.test/v1', auth: { kind: 'none' }, headers: {}, proxyId: null },
  driverOptions: {}, models: {},
};

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true, value() { this.setAttribute('open', ''); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true, value() { this.removeAttribute('open'); },
  });
});

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  vi.clearAllMocks();
  useInferenceStore.setState({
    refresh: vi.fn(async () => undefined),
    refreshCatalog,
    upsertCatalogModel,
    upsertProviderModel,
  });
  useProxyStore.setState({ fetchConfig: vi.fn(async () => undefined) });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useInferenceStore.setState(originalInference, true);
  useProxyStore.setState(originalProxy, true);
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

async function render(
  editing = false,
  gateway: 'ai' | 'image' = 'ai',
  onFlash = vi.fn(),
): Promise<void> {
  const binding = { catalogId: saved.id, upstreamId: 'example-model', enabled: true, options: {} };
  await act(async () => root.render(createElement(ModelForge, {
    gateway,
    spec: vendorsFor(gateway).find((spec) => spec.key === (gateway === 'ai' ? 'openai' : 'openai-image'))!,
    providerId: 'example-provider', provider: editing ? { ...provider, models: { 'example-model': binding } } : provider,
    editingModelId: editing ? 'example-model' : undefined,
    definitions: gateway === 'ai' ? [saved] : [],
    catalogDefinitions: gateway === 'ai' ? [system] : [],
    providerNames: [], onClose: vi.fn(), onSaved: vi.fn(), onFlash,
  })));
}

const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const button = (label: string) => [...container.querySelectorAll('button')]
  .find((node) => node.textContent?.trim() === label)!;
const ariaButton = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

describe('ModelForge catalog and saved model views', () => {
  it('refreshes the official catalog from both AI and image add-model dialogs', async () => {
    const onFlash = vi.fn();
    await render(false, 'ai', onFlash);
    await act(async () => ariaButton('Refresh official model catalog').click());
    expect(refreshCatalog).toHaveBeenCalledOnce();
    expect(onFlash).toHaveBeenCalledWith({
      kind: 'message', key: 'settings.modelForge.catalogUpdated',
    });

    await render(false, 'image');
    expect(ariaButton('Refresh official model catalog')).toBeTruthy();
  });

  it('keeps refresh failures inside the open dialog', async () => {
    refreshCatalog.mockRejectedValueOnce(new Error('Catalog unavailable'));
    await render();

    await act(async () => ariaButton('Refresh official model catalog').click());

    expect(container.textContent).toContain(
      'Could not refresh the model catalog; showing the last available list',
    );
  });

  it('suggests the original system model and copies its defaults into a new local model', async () => {
    await render();
    await act(async () => input('Model ID').focus());
    const option = container.querySelector<HTMLButtonElement>('[role="option"]')!;
    expect(option.textContent).toContain('System Model');
    expect(option.textContent).not.toContain('Saved Model');
    await act(async () => option.click());
    expect(input('Display Name').value).toBe('System Model');
    await act(async () => button('Add Model').click());
    expect(upsertCatalogModel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'custom/example-provider/example-model', displayName: 'System Model', limits: { contextWindow: 128_000 },
    }));
    expect(upsertProviderModel).toHaveBeenCalledWith('ai', 'example-provider', 'example-model',
      expect.objectContaining({ catalogId: 'custom/example-provider/example-model' }), undefined);
  });

  it('opens the saved values for editing while the same dropdown entry retains system values', async () => {
    await render(true);
    expect(input('Display Name').value).toBe('Saved Model');
    await act(async () => input('Model ID').focus());
    const option = container.querySelector<HTMLButtonElement>('[role="option"]')!;
    expect(option.textContent).toContain('System Model');
    await act(async () => button('Save').click());
    expect(upsertCatalogModel).not.toHaveBeenCalled();
    expect(upsertProviderModel).toHaveBeenCalledOnce();
    expect(saved.limits.contextWindow).toBe(96_000);
  });
});
