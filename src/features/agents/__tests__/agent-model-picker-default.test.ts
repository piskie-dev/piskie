import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { InferenceConfig, InferenceModelDefinition } from '@shared/types/inference';
import { useInferenceStore } from '@/store/inferenceStore';
import { useWorkerPreferencesStore } from '../worker-preferences-store';
import { AgentManagementPage } from '../AgentManagementPage';
import '@/i18n';

const initialInference = useInferenceStore.getState();
const initialWorkers = useWorkerPreferencesStore.getState();
const workerType = 'example-worker';
let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

const model = (id: string): InferenceModelDefinition => ({
  id, displayName: `Model ${id}`, kind: 'ai', lifecycle: 'active',
  compatibleDrivers: ['openai'], inputModalities: ['text'], outputModalities: ['text'],
  capabilities: {}, limits: {}, source: { kind: 'local', version: 'test' },
});
const providers = Object.fromEntries(['first', 'second'].map((id) => [id, {
  displayName: `Provider ${id}`, driver: 'openai', enabled: true,
  connection: { baseUrl: 'https://api.example.test', auth: { kind: 'none' as const }, headers: {}, proxyId: null },
  models: { [id]: { catalogId: id, upstreamId: id, enabled: true, options: {} } },
  driverOptions: {},
}]));
const config: InferenceConfig = {
  schemaVersion: 1, revision: 1, providers,
  policies: {
    ai: { maxAttempts: 1, connectTimeoutMs: 1000, streamIdleTimeoutMs: 1000, retryBaseDelayMs: 100 },
    image: { maxSubmitAttempts: 1, submitTimeoutMs: 1000, operationTimeoutMs: 1000, allowResubmitAfterAccepted: false },
  },
};

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent: () => {}, detachEvent: () => {} });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
});

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  useInferenceStore.setState({
    config, selections: null, models: { ai: [model('first'), model('second')], image: [] },
    availableTargets: {
      ai: ['first', 'second'].map((id) => ({ providerId: id, modelId: id, catalogId: id })), image: [],
    },
    error: null, refresh: async () => {},
  });
  useWorkerPreferencesStore.setState({
    refresh: async () => {},
    document: { schemaVersion: 1, revision: 1, profiles: {
      [workerType]: { inference: { target: { providerId: 'first', modelId: 'first' }, reasoning: { kind: 'provider-default' } } },
    } },
    types: [{ type: workerType, description: 'Example worker' }],
    selected: workerType, drafts: {}, loading: false, saving: null, loadError: null,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useInferenceStore.setState(initialInference, true);
  useWorkerPreferencesStore.setState(initialWorkers, true);
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

const click = (button: HTMLButtonElement) => act(async () => button.click());
const pickerProvider = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('dialog nav button')]
  .find((button) => button.querySelector('span')?.textContent === label)!;
const modelTrigger = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
const mount = () => act(async () => root.render(createElement(MemoryRouter, { initialEntries: ['/agents'] },
  createElement(Routes, null,
    createElement(Route, { path: '/agents', element: createElement(AgentManagementPage) }),
    createElement(Route, { path: '/preferences', element: createElement('p', null, 'Provider settings') }),
  ))));
const setDefault = (providerId: string) => act(async () => useInferenceStore.setState({ selections: {
  schemaVersion: 1, revision: 1, ai: { providerId, modelId: providerId },
} }));

it('prioritizes the agent model over the global default, tracks agent changes, and resets manual filters on reopen', async () => {
  await setDefault('second');
  await mount();
  const trigger = modelTrigger();
  expect(trigger.querySelector('svg.lucide-settings')).not.toBeNull();
  expect(container.textContent).not.toContain('管理模型');
  await click(trigger);
  expect(pickerProvider('Provider first').getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('dialog[open]')?.textContent).toContain('管理模型');
  expect(container.querySelector('dialog[open] section[aria-label="Provider first"] button[aria-pressed="true"]')).not.toBeNull();
  expect(container.querySelector('dialog[open] section[aria-label="Provider second"]')).toBeNull();

  await setDefault('first');
  expect(pickerProvider('Provider first').getAttribute('aria-pressed')).toBe('true');
  await act(async () => useWorkerPreferencesStore.setState({ document: {
    schemaVersion: 1, revision: 2, profiles: {
      [workerType]: { inference: { target: { providerId: 'second', modelId: 'second' }, reasoning: { kind: 'provider-default' } } },
    },
  } }));
  expect(pickerProvider('Provider second').getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('dialog[open] section[aria-label="Provider first"]')).toBeNull();
  expect(container.querySelector('dialog[open] section[aria-label="Provider second"]')).not.toBeNull();

  await click(pickerProvider('全部提供商'));
  await setDefault('second');
  expect(pickerProvider('全部提供商').getAttribute('aria-pressed')).toBe('true');
  await click(pickerProvider('Provider first'));
  expect(pickerProvider('Provider first').getAttribute('aria-pressed')).toBe('true');

  await click(container.querySelector<HTMLButtonElement>('dialog button[aria-label="关闭"]')!);
  await click(trigger);
  expect(pickerProvider('Provider second').getAttribute('aria-pressed')).toBe('true');
  const manage = [...container.querySelectorAll<HTMLButtonElement>('dialog button')]
    .find((button) => button.textContent?.includes('管理模型'))!;
  await click(manage);
  expect(container.textContent).toContain('Provider settings');
});

it('follows the async global default only when the agent has no specified model', async () => {
  useWorkerPreferencesStore.setState({ document: { schemaVersion: 1, revision: 1, profiles: {} } });
  await mount();
  const fixed = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.querySelector('strong')?.textContent === '指定模型')!;
  await click(fixed);
  const trigger = modelTrigger();
  await click(trigger);
  expect(pickerProvider('全部提供商').getAttribute('aria-pressed')).toBe('true');

  await setDefault('second');
  expect(pickerProvider('Provider second').getAttribute('aria-pressed')).toBe('true');
  await click(pickerProvider('全部提供商'));
  await setDefault('first');
  expect(pickerProvider('全部提供商').getAttribute('aria-pressed')).toBe('true');
  await click(pickerProvider('Provider second'));
  expect(pickerProvider('Provider second').getAttribute('aria-pressed')).toBe('true');

  await click(container.querySelector<HTMLButtonElement>('dialog button[aria-label="关闭"]')!);
  await click(trigger);
  expect(pickerProvider('Provider first').getAttribute('aria-pressed')).toBe('true');
});

it('keeps the agent provider when its model is unavailable and provider options load later', async () => {
  await setDefault('second');
  useWorkerPreferencesStore.setState({ document: { schemaVersion: 1, revision: 1, profiles: {
    [workerType]: { inference: { target: { providerId: 'first', modelId: 'retired' }, reasoning: { kind: 'provider-default' } } },
  } } });
  useInferenceStore.setState({ config: null });
  await mount();
  const reselect = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes('重新选择模型'))!;
  await click(reselect);
  expect(pickerProvider('全部提供商').getAttribute('aria-pressed')).toBe('true');

  await act(async () => useInferenceStore.setState({ config }));
  expect(pickerProvider('Provider first').getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('dialog[open] section[aria-label="Provider first"] button[aria-pressed="true"]')).toBeNull();
  await act(async () => useInferenceStore.setState({ config: { ...config, providers: { second: providers.second! } } }));
  expect(pickerProvider('全部提供商').getAttribute('aria-pressed')).toBe('true');
  expect(pickerProvider('Provider second').getAttribute('aria-pressed')).toBe('false');
  await click(pickerProvider('Provider second'));
  await act(async () => useInferenceStore.setState({ config }));
  expect(pickerProvider('Provider second').getAttribute('aria-pressed')).toBe('true');
  await click(container.querySelector<HTMLButtonElement>('dialog button[aria-label="关闭"]')!);
  await click([...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes('重新选择模型'))!);
  expect(pickerProvider('Provider first').getAttribute('aria-pressed')).toBe('true');
});
