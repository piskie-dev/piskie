import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceConfig, InferenceModelDefinition } from '@shared/types/inference';
import { useInferenceStore } from '@/store/inferenceStore';
import { useProxyStore } from '@/store/proxyStore';
import { ProviderDesk } from '../desks/ProviderDesk';

const initialInference = useInferenceStore.getState();
const initialProxy = useProxyStore.getState();
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useInferenceStore.setState(initialInference, true);
  useProxyStore.setState(initialProxy, true);
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
