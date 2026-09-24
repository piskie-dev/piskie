import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceConfig, InferenceModelDefinition, InferenceProbeReceipt } from '@shared/types/inference';
import { deferred, gifBytes } from '@/features/console/attachments/__tests__/fixtures';
import { messageText } from '@/i18n/presentationText';
import { useInferenceStore } from '@/store/inferenceStore';
import { useProxyStore } from '@/store/proxyStore';
import { useWebSearchStore } from '@/store/webSearchStore';

let PrefDeckPage: typeof import('../PrefDeckPage').PrefDeckPage;
let ProviderDesk: typeof import('../desks/ProviderDesk').ProviderDesk;
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const nodeRequire = createRequire(import.meta.url);
const previousCssLoader = nodeRequire.extensions['.css'];
const initialInference = useInferenceStore.getState();
const initialSearch = useWebSearchStore.getState();
const initialProxy = useProxyStore.getState();
const publish = vi.fn();
const writeText = vi.fn();
const onFlash = vi.fn();
const probe = vi.fn();
const bytes = gifBytes();
const dataUrl = `data:image/gif;base64,${Buffer.from(bytes).toString('base64')}`;
const config: InferenceConfig = {
  schemaVersion: 1, revision: 1,
  providers: { sample: {
    displayName: 'Sample provider', driver: 'openai', enabled: true,
    connection: { baseUrl: 'https://api.example.test', auth: { kind: 'bearer', value: 'sample-key' }, headers: {}, proxyId: null },
    models: { 'sample-model': { catalogId: 'sample-catalog', upstreamId: 'sample-upstream', enabled: true, options: {} } }, driverOptions: {},
  } },
  policies: {
    ai: { maxAttempts: 1, connectTimeoutMs: 1000, streamIdleTimeoutMs: 1000, retryBaseDelayMs: 100 },
    image: { maxSubmitAttempts: 1, submitTimeoutMs: 1000, operationTimeoutMs: 1000, allowResubmitAfterAccepted: false },
  },
};
const model: InferenceModelDefinition = {
  id: 'sample-catalog', displayName: 'Sample model', kind: 'image', lifecycle: 'active',
  compatibleDrivers: ['openai'], inputModalities: ['text'], outputModalities: ['image'],
  capabilities: { generate: true }, limits: {}, source: { kind: 'local', version: 'sample' },
};
const receipt: InferenceProbeReceipt = {
  driverId: 'openai', providerId: 'sample', modelId: 'sample-model', level: 'smoke', success: true,
  startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:00:01Z',
  artifacts: [{ artifactId: 'sample-artifact', mimeType: 'image/gif' }],
};

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'localStorage'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.assign(window, { piskie: { desktop: { files: { copyImage: publish } } } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  nodeRequire.extensions['.css'] = () => undefined;
  ({ PrefDeckPage } = await import('../PrefDeckPage'));
  ({ ProviderDesk } = await import('../desks/ProviderDesk'));
});
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  publish.mockReset().mockResolvedValue(undefined);
  writeText.mockReset().mockResolvedValue(undefined);
  onFlash.mockReset();
  probe.mockReset().mockResolvedValue([receipt]);
  useInferenceStore.setState({
    config, models: { ai: [], image: [model] }, catalogModels: { ai: [], image: [model] },
    drivers: [{ id: 'openai', supportedGateways: ['image'], acceptedAuth: ['bearer'] }],
    isLoading: false, error: null, probe,
    readArtifact: async () => ({ artifactId: 'sample-artifact', mimeType: 'image/gif', dataUrl }),
    subscribeToConfigChanges: () => () => undefined,
  });
  useWebSearchStore.setState({
    config: { revision: 1, enabled: false, defaultProvider: null, providers: {} }, presets: [], error: null,
    refresh: async () => undefined, subscribeToConfigChanges: () => () => undefined,
  });
  useProxyStore.setState({ config: { proxies: [] } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useInferenceStore.setState(initialInference, true);
  useWebSearchStore.setState(initialSearch, true);
  useProxyStore.setState(initialProxy, true);
});
afterAll(() => {
  if (previousCssLoader) nodeRequire.extensions['.css'] = previousCssLoader;
  else delete nodeRequire.extensions['.css'];
  dom.window.close();
  vi.unstubAllGlobals();
});

const button = (key: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === i18n.t(key))!;
const copyButton = () => container.querySelector<HTMLButtonElement>('[data-copy-status]')!;
const click = (element: HTMLElement) => act(async () => element.click());
async function renderProvider() {
  await act(async () => root.render(createElement(ProviderDesk, {
    gateway: 'image', providerId: 'sample', onFlash, onShowImage: vi.fn(), onEditModel: vi.fn(), onVanish: vi.fn(), onOpenExplore: vi.fn(),
  })));
}
async function renderPreview() {
  await act(async () => root.render(createElement(MemoryRouter, { initialEntries: ['/preferences?sect=image'] }, createElement(PrefDeckPage))));
  await click(button('settings.provider.testConnection'));
  await click(container.querySelector('img')!);
}

describe('settings copy feedback', () => {
  it.each(['success', 'failure'] as const)('waits for API key copy %s before showing the existing flash', async (outcome) => {
    const pending = deferred<void>();
    writeText.mockReturnValueOnce(pending.promise);
    await renderProvider();
    await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('settings.provider.copyKey')}"]`)!);
    expect(writeText).toHaveBeenCalledExactlyOnceWith('sample-key');
    expect(onFlash).not.toHaveBeenCalled();
    await act(async () => { if (outcome === 'success') pending.resolve(); else pending.reject(new Error('denied')); });
    if (outcome === 'success') expect(onFlash).toHaveBeenCalledExactlyOnceWith(messageText('settings.provider.copied'));
    else expect(onFlash).toHaveBeenCalledExactlyOnceWith(messageText('clipboardUi.copyFailed'), 'halt');
  });

  it.each(['success', 'failure'] as const)('waits for upstream error copy %s before showing the existing flash', async (outcome) => {
    probe.mockResolvedValueOnce([{ ...receipt, success: false, error: { upstream: { body: 'sample upstream failure\n' } } }]);
    const pending = deferred<void>();
    writeText.mockReturnValueOnce(pending.promise);
    await renderProvider();
    await click(button('settings.provider.testConnection'));
    onFlash.mockClear();
    await click(button('settings.provider.copyError'));
    expect(writeText).toHaveBeenCalledExactlyOnceWith('sample upstream failure\n');
    expect(onFlash).not.toHaveBeenCalled();
    await act(async () => { if (outcome === 'success') pending.resolve(); else pending.reject(new Error('denied')); });
    if (outcome === 'success') expect(onFlash).toHaveBeenCalledExactlyOnceWith(messageText('settings.provider.copiedUpstreamError'));
    else expect(onFlash).toHaveBeenCalledExactlyOnceWith(messageText('clipboardUi.copyFailed'), 'halt');
  });

  it('copies the probe original in its existing dialog without closing it or leaking feedback across reopening', async () => {
    const pending = deferred<void>();
    publish.mockReturnValueOnce(pending.promise);
    await renderPreview();
    const dialog = container.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('img')?.src).toBe(dataUrl);
    await click(copyButton());
    expect(publish).toHaveBeenCalledExactlyOnceWith({ kind: 'bytes', bytes: bytes.buffer, name: undefined });
    expect(dialog.open).toBe(true);
    expect(copyButton().disabled).toBe(true);
    await click(dialog.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('common.close')}"]`)!);
    expect(dialog.open).toBe(false);
    await click(container.querySelector('img')!);
    expect(copyButton().disabled).toBe(true);
    await act(async () => pending.resolve());
    expect(copyButton().textContent).toBe('Copy image');
    expect(dialog.open).toBe(true);
  });

  it('shows a probe image publication error in the same dialog', async () => {
    publish.mockRejectedValueOnce(new Error('publication failed'));
    await renderPreview();
    await click(copyButton());
    expect(copyButton().textContent).toBe('Copy failed');
    expect(container.querySelector('dialog')!.open).toBe(true);
  });
});
